import type { ResponseItem } from "./imapStream"
import type { Email } from "../types/emails"
import { parseHeaders, parseAddresses, parseMime, extractContent } from "./mime"
import { parseInternalDate } from "./imapList"

export type StoreResult = {
    seq: number,
    flags: string[],
    /** Modification sequence (CONDSTORE, RFC 7162 §3.1.3), if the server reported one */
    modSeq?: number
}

/**
 * Parses the untagged FETCH responses a STORE command produces into
 * per-message flag results.
 *
 * The data items inside `FETCH (...)` may arrive in any order, and once
 * CONDSTORE is enabled (RFC 7162) the server MUST include a `MODSEQ (n)`
 * item in every one of these responses — so the parser must tolerate
 * arbitrary items around `FLAGS (...)` rather than expecting an exact shape.
 */
export function parseStoreResponse(items: ResponseItem[]): StoreResult[] {
    const results: StoreResult[] = []

    for (const item of items) {
        const m = /^\* (\d+) FETCH \((.*)\)$/.exec(item.line)
        if (!m) continue

        const data = m[2]!
        const flagsMatch = /(?:^| )FLAGS \(([^)]*)\)/.exec(data)
        if (!flagsMatch) continue

        const result: StoreResult = {
            seq: parseInt(m[1]!),
            flags: flagsMatch[1]!.split(/\s+/).filter(Boolean).map(f => f.replace(/^\\/, ""))
        }

        const modSeqMatch = /(?:^| )MODSEQ \((\d+)\)/.exec(data)
        if (modSeqMatch) result.modSeq = parseInt(modSeqMatch[1]!)

        results.push(result)
    }

    return results
}

type FetchToken =
    | { kind: "text", text: string }
    | { kind: "literal", bytes: Uint8Array }

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 1) return chunks[0]!
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Uint8Array(total)
    let pos = 0
    for (const c of chunks) {
        out.set(c, pos)
        pos += c.length
    }
    return out
}

const CRLFCRLF_BYTES = new Uint8Array([13, 10, 13, 10])

function indexOfHeaderEnd(bytes: Uint8Array): number {
    outer: for (let i = 0; i <= bytes.length - CRLFCRLF_BYTES.length; i++) {
        for (let j = 0; j < CRLFCRLF_BYTES.length; j++) {
            if (bytes[i + j] !== CRLFCRLF_BYTES[j]) continue outer
        }
        return i
    }
    return -1
}

/**
 * Parses the untagged responses of a FETCH command into Email objects.
 *
 * Literal data is kept as raw bytes all the way into the MIME parser: the
 * part's charset is only known once its headers are parsed, so decoding the
 * literal to a string up front (with any fixed charset) would corrupt every
 * body whose bytes are not valid in that charset — in particular raw 8-bit
 * bodies (Content-Transfer-Encoding: 8bit) in any non-UTF-8 charset.
 *
 * The `raw` / `body.raw` / `rawHeaders` string fields are decoded as UTF-8
 * for display; the parsed `body.text`, `body.html` and attachment contents
 * are produced from the original bytes and each part's declared charset.
 */
export function parseFetchEmails(items: ResponseItem[], { fetchBody = true }: { fetchBody?: boolean } = {}): Email[] {
    const utf8 = new TextDecoder("utf-8")
    const emails: Email[] = []
    const tokens: FetchToken[] = []

    for (const item of items) {
        const m = /\{(\d+)\+?\}$/.exec(item.line)
        if (m && item.literal) {
            tokens.push({ kind: "text", text: item.line.slice(0, -m[0].length) })
            tokens.push({ kind: "literal", bytes: item.literal })
        } else {
            tokens.push({ kind: "text", text: item.line })
        }
    }

    let i = 0
    while (i < tokens.length) {
        const token = tokens[i]!
        const opening = token.kind === "text" ? /^\* (\d+) FETCH \(([\s\S]*)$/.exec(token.text) : null
        if (!opening) {
            i++
            continue
        }

        const seq = parseInt(opening[1])
        i++

        // Collect the fetch data until the standalone closing paren
        let data = opening[2] ?? ""
        const parts: { section: "header" | "body", bytes: Uint8Array }[] = []
        let pendingSection: "header" | "body" | null = null
        if (/BODY\[HEADER/i.test(data)) pendingSection = "header"
        else if (/BODY\[/i.test(data)) pendingSection = "body"

        for (; i < tokens.length; i++) {
            const t = tokens[i]!
            if (t.kind === "literal") {
                if (pendingSection) parts.push({ section: pendingSection, bytes: t.bytes })
                pendingSection = null
                continue
            }
            // Don't let the tagged completion response leak into the fetch data
            if (/^\S+ (OK|NO|BAD)( |$)/.test(t.text)) break
            if (t.text.trim() === ")") {
                i++
                break
            }
            data += " " + t.text
            if (/BODY\[HEADER/i.test(t.text)) pendingSection = "header"
            else if (/BODY\[/i.test(t.text)) pendingSection = "body"
        }

        const uidMatch = /UID (\d+)/.exec(data)
        const flagsMatch = /FLAGS \(([^)]*)\)/.exec(data)
        const dateMatch = /INTERNALDATE "([^"]+)"/.exec(data)
        const sizeMatch = /RFC822\.SIZE (\d+)/.exec(data)

        // Large bodies may be split into multiple BODY[]<origin>
        // literals — concatenate the chunks in order.
        const headerBytes = concatBytes(parts.filter(p => p.section === "header").map(p => p.bytes))
        const bodyBytes = concatBytes(parts.filter(p => p.section === "body").map(p => p.bytes))

        const rawBytes = fetchBody && bodyBytes.length ? bodyBytes : new Uint8Array(0)
        const rawMessage = rawBytes.length ? utf8.decode(rawBytes) : ""

        let headerStr: string
        if (rawBytes.length) {
            const sepIdx = indexOfHeaderEnd(rawBytes)
            headerStr = utf8.decode(sepIdx === -1 ? rawBytes : rawBytes.subarray(0, sepIdx))
        } else {
            headerStr = utf8.decode(headerBytes)
        }

        const headerMap = parseHeaders(headerStr)

        const email: Email = {
            uid: uidMatch ? parseInt(uidMatch[1]) : NaN,
            seq,
            flags: flagsMatch
                ? flagsMatch[1].split(/\s+/).filter(Boolean).map(f => f.replace(/^\\/, ""))
                : [],
            internalDate: dateMatch ? parseInternalDate(dateMatch[1]) : new Date(NaN),
            size: sizeMatch ? parseInt(sizeMatch[1]) : NaN,
            from: parseAddresses(headerMap["from"] ?? ""),
            to: parseAddresses(headerMap["to"] ?? ""),
            cc: parseAddresses(headerMap["cc"] ?? ""),
            subject: headerMap["subject"] ?? "",
            messageID: headerMap["message-id"] ?? "",
            contentType: headerMap["content-type"] ?? "",
            headers: headerMap,
            rawHeaders: headerStr,
            body: {
                text: undefined,
                html: undefined,
                raw: rawMessage
            },
            attachments: [],
            raw: rawMessage || headerStr
        }

        if (rawBytes.length) {
            const root = parseMime(rawBytes)
            const extracted = extractContent(root)
            email.body.text = extracted.text
            email.body.html = extracted.html
            email.attachments = extracted.attachments
        }

        emails.push(email)
    }

    return emails
}
