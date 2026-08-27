import type { ResponseItem } from "./imapStream"

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
