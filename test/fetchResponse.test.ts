import { describe, test, expect } from "bun:test"
import { parseStoreResponse, parseFetchEmails, buildHeaderFieldsSection, DEFAULT_HEADER_FIELDS } from "../src/utils/fetchResponse"

const item = (line: string, literal: Uint8Array | null = null) => ({ line, literal })

const enc = (s: string) => new TextEncoder().encode(s)

/** Builds the ResponseItems of one FETCH response carrying a single BODY[] literal. */
const fetchItems = (literal: Uint8Array, data = "UID 5 FLAGS (\\Seen)") => [
    item(`* 1 FETCH (${data} BODY[] {${literal.length}}`, literal),
    item(")")
]

describe("parseStoreResponse", () => {
    test("parses a bare IMAP4rev1 FLAGS response", () => {
        const result = parseStoreResponse([item("* 1 FETCH (FLAGS (\\Seen))")])
        expect(result).toEqual([{ seq: 1, flags: ["Seen"] }])
    })

    test("parses a UID STORE response with the UID item first", () => {
        const result = parseStoreResponse([item("* 2 FETCH (UID 42 FLAGS (\\Seen \\Flagged))")])
        expect(result).toEqual([{ seq: 2, flags: ["Seen", "Flagged"] }])
    })

    test("parses a UID STORE response with the UID item last", () => {
        const result = parseStoreResponse([item("* 2 FETCH (FLAGS (\\Answered) UID 7)")])
        expect(result).toEqual([{ seq: 2, flags: ["Answered"] }])
    })

    test("parses the MODSEQ item CONDSTORE requires (RFC 7162 §3.1.3)", () => {
        const result = parseStoreResponse([item("* 1 FETCH (UID 42 MODSEQ (12345) FLAGS (\\Seen))")])
        expect(result).toEqual([{ seq: 1, flags: ["Seen"], modSeq: 12345 }])
    })

    test("parses MODSEQ regardless of item order", () => {
        const result = parseStoreResponse([item("* 3 FETCH (FLAGS (\\Deleted) MODSEQ (999) UID 5)")])
        expect(result).toEqual([{ seq: 3, flags: ["Deleted"], modSeq: 999 }])
    })

    test("parses an empty flag list", () => {
        const result = parseStoreResponse([item("* 4 FETCH (MODSEQ (100) FLAGS ())")])
        expect(result).toEqual([{ seq: 4, flags: [], modSeq: 100 }])
    })

    test("parses several messages in one response", () => {
        const result = parseStoreResponse([
            item("* 1 FETCH (UID 10 MODSEQ (51) FLAGS (\\Seen))"),
            item("* 2 FETCH (UID 11 MODSEQ (52) FLAGS (\\Seen \\Flagged))")
        ])
        expect(result).toEqual([
            { seq: 1, flags: ["Seen"], modSeq: 51 },
            { seq: 2, flags: ["Seen", "Flagged"], modSeq: 52 }
        ])
    })

    test("ignores unrelated untagged responses", () => {
        const result = parseStoreResponse([
            item("* 12 EXISTS"),
            item("* OK [HIGHESTMODSEQ 100] noted"),
            item("* 1 FETCH (FLAGS (\\Seen))")
        ])
        expect(result).toEqual([{ seq: 1, flags: ["Seen"] }])
    })

    test("ignores FETCH responses without a FLAGS item", () => {
        const result = parseStoreResponse([item("* 1 FETCH (UID 42 MODSEQ (12345))")])
        expect(result).toEqual([])
    })
})

describe("parseFetchEmails", () => {
    test("parses UID, FLAGS, INTERNALDATE and RFC822.SIZE", () => {
        const raw = enc("Subject: Hi\r\nFrom: a@example.com\r\n\r\nHello\r\n")
        const [email] = parseFetchEmails([
            item(`* 3 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE "01-Jan-2024 10:00:00 +0000" RFC822.SIZE ${raw.length} BODY[] {${raw.length}}`, raw),
            item(")")
        ])
        expect(email!.uid).toBe(42)
        expect(email!.seq).toBe(3)
        expect(email!.flags).toEqual(["Seen"])
        expect(email!.size).toBe(raw.length)
        expect(email!.subject).toBe("Hi")
        expect(email!.body.text).toBe("Hello\r\n")
    })

    test("keeps a raw 8-bit latin-1 body intact until its charset is known", () => {
        // "Café au lait." with a literal 0xE9 — invalid as UTF-8. Decoding the
        // literal to a UTF-8 string first would turn 0xE9 into U+FFFD before
        // the MIME parser ever sees the part's declared charset.
        const head = enc("Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
        const body = Uint8Array.from([...enc("Caf"), 0xe9, ...enc(" au lait.")])
        const raw = Uint8Array.from([...head, ...body])

        const [email] = parseFetchEmails(fetchItems(raw))
        expect(email!.body.text).toBe("Café au lait.")
    })

    test("keeps 8-bit bytes in non-latin-1 charsets too", () => {
        // 0xE1 is α in ISO-8859-7
        const head = enc("Content-Type: text/plain; charset=iso-8859-7\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
        const raw = Uint8Array.from([...head, 0xe1])

        const [email] = parseFetchEmails(fetchItems(raw))
        expect(email!.body.text).toBe("α")
    })

    test("still decodes a UTF-8 body as UTF-8", () => {
        const raw = enc("Content-Type: text/plain; charset=utf-8\r\n\r\nhéllo €\r\n")
        const [email] = parseFetchEmails(fetchItems(raw))
        expect(email!.body.text).toBe("héllo €\r\n")
        expect(email!.raw).toContain("héllo €")
    })

    test("preserves binary attachment bytes exactly", () => {
        const payload = Uint8Array.from([0x00, 0xff, 0x80, 0x7f, 0xe9])
        const head = enc([
            'Content-Type: multipart/mixed; boundary="B"',
            "",
            "--B",
            "Content-Type: text/plain",
            "",
            "see attachment",
            "--B",
            "Content-Type: application/octet-stream",
            'Content-Disposition: attachment; filename="blob.bin"',
            "Content-Transfer-Encoding: 8bit",
            "",
            ""
        ].join("\r\n"))
        const tail = enc("\r\n--B--\r\n")
        const raw = Uint8Array.from([...head, ...payload, ...tail])

        const [email] = parseFetchEmails(fetchItems(raw))
        expect(email!.attachments).toHaveLength(1)
        const b64 = email!.attachments[0]!.contentBase64
        expect(Uint8Array.from(atob(b64), c => c.charCodeAt(0))).toEqual(payload)
    })

    test("concatenates split BODY[]<origin> literal chunks as bytes", () => {
        const raw = enc("Content-Type: text/plain; charset=utf-8\r\n\r\nfirst half+second half\r\n")
        const a = raw.subarray(0, 40)
        const b = raw.subarray(40)
        const [email] = parseFetchEmails([
            item(`* 1 FETCH (UID 5 FLAGS (\\Seen) BODY[]<0> {${a.length}}`, a),
            item(` BODY[]<40> {${b.length}}`, b),
            item(")")
        ])
        expect(email!.body.text).toBe("first half+second half\r\n")
    })

    test("parses a header-only fetch (fetchBody: false)", () => {
        const header = enc("Subject: Just headers\r\nFrom: a@example.com\r\nMessage-ID: <x@y>\r\n\r\n")
        const [email] = parseFetchEmails([
            item(`* 2 FETCH (UID 9 FLAGS () BODY[HEADER.FIELDS (SUBJECT FROM MESSAGE-ID)] {${header.length}}`, header),
            item(")")
        ], { fetchBody: false })
        expect(email!.uid).toBe(9)
        expect(email!.subject).toBe("Just headers")
        expect(email!.messageID).toBe("<x@y>")
        expect(email!.body.raw).toBe("")
    })

    test("parses several messages in one response", () => {
        const one = enc("Subject: One\r\n\r\nfirst\r\n")
        const two = enc("Subject: Two\r\n\r\nsecond\r\n")
        const emails = parseFetchEmails([
            item(`* 1 FETCH (UID 1 FLAGS () BODY[] {${one.length}}`, one),
            item(")"),
            item(`* 2 FETCH (UID 2 FLAGS () BODY[] {${two.length}}`, two),
            item(")")
        ])
        expect(emails.map(e => e.subject)).toEqual(["One", "Two"])
        expect(emails.map(e => e.body.text)).toEqual(["first\r\n", "second\r\n"])
    })
})

describe("buildHeaderFieldsSection", () => {
    test("requests the threading headers by default (RFC 5322 §3.6.4)", () => {
        const section = buildHeaderFieldsSection()
        expect(section).toBe("HEADER.FIELDS (SUBJECT FROM TO CC MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE DATE)")
        expect(DEFAULT_HEADER_FIELDS).toContain("REFERENCES")
        expect(DEFAULT_HEADER_FIELDS).toContain("IN-REPLY-TO")
    })

    test("accepts a caller-chosen field list and normalizes case", () => {
        expect(buildHeaderFieldsSection(["subject", "x-priority"])).toBe("HEADER.FIELDS (SUBJECT X-PRIORITY)")
    })

    test("rejects field names that would break the IMAP command", () => {
        expect(() => buildHeaderFieldsSection([])).toThrow()
        expect(() => buildHeaderFieldsSection(["SUB JECT"])).toThrow()
        expect(() => buildHeaderFieldsSection(["SUBJECT:"])).toThrow()
        expect(() => buildHeaderFieldsSection(["SUBJ)ECT (X"])).toThrow()
        expect(() => buildHeaderFieldsSection([""])).toThrow()
        expect(() => buildHeaderFieldsSection(["日付"])).toThrow()
    })
})
