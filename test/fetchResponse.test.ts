import { describe, test, expect } from "bun:test"
import { parseStoreResponse } from "../src/utils/fetchResponse"

const item = (line: string) => ({ line, literal: null })

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
