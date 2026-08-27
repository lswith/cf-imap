import { describe, expect, test } from "bun:test"
import { ImapStream, ImapError } from "../src/utils/imapStream"

// Deterministic: each read() returns exactly one chunk, in order
const toStream = (chunks: (string | Uint8Array)[]): ReadableStream => new ReadableStream({
    start(controller) {
        for (const c of chunks) {
            controller.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : c)
        }
        controller.close()
    }
})

describe("ImapStream", () => {
    test("reads a single line", async () => {
        const s = new ImapStream(toStream(["* OK ready\r\n"]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* OK ready")
        expect(item.literal).toBeNull()
    })

    test("reads a line split across chunks", async () => {
        const s = new ImapStream(toStream(["* OK ", "ready", "\r\n"]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* OK ready")
    })

    test("decodes multi-byte UTF-8 split across chunks", async () => {
        const s = new ImapStream(toStream([new Uint8Array([0x2a, 0x20, 0xc3]), new Uint8Array([0xa4, 0x0d, 0x0a])]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* ä")
    })

    test("reads a literal spanning chunks", async () => {
        const s = new ImapStream(toStream([
            "* 1 FETCH (BODY[] {5}\r\n",
            new Uint8Array([0x68, 0x65]),
            new Uint8Array([0x6c, 0x6c, 0x6f]),
            ")\r\n"
        ]).getReader())
        const item = await s.readItem()
        expect(item.line).toBe("* 1 FETCH (BODY[] {5}")
        expect(new TextDecoder().decode(item.literal)).toBe("hello")
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("reads an empty literal", async () => {
        const s = new ImapStream(toStream(["{0}\r\n)\r\n"]).getReader())
        const item = await s.readItem()
        expect(item.literal!.length).toBe(0)
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("literal content containing CRLF is not split", async () => {
        const s = new ImapStream(toStream(["* 1 FETCH (BODY[] {9}\r\n", "a\r\nb\r\nc\r\n", ")\r\n"]).getReader())
        const item = await s.readItem()
        expect(new TextDecoder().decode(item.literal)).toBe("a\r\nb\r\nc\r\n")
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("readUntilTag collects untagged items and returns on OK", async () => {
        const s = new ImapStream(toStream([
            "* FLAGS (\\Seen \\Deleted)\r\n",
            "* 3 EXISTS\r\n",
            "A1 OK [UIDVALIDITY 5] completed\r\n"
        ]).getReader())
        const { items, tagged } = await s.readUntilTag("A1")
        expect(items.map(i => i.line)).toEqual(["* FLAGS (\\Seen \\Deleted)", "* 3 EXISTS"])
        expect(tagged.line).toBe("A1 OK [UIDVALIDITY 5] completed")
    })

    test("readUntilTag throws ImapError on NO", async () => {
        const s = new ImapStream(toStream(["A1 NO Login failed\r\n"]).getReader())
        const p = s.readUntilTag("A1")
        await expect(p).rejects.toThrow(ImapError)
        await expect(p).rejects.toThrow(/Login failed/)
    })

    test("readUntilTag with continuation stops at + line", async () => {
        const s = new ImapStream(toStream(["A1 APPEND INBOX\r\n", "+ Ready for literal data\r\n"]).getReader())
        const { items, tagged } = await s.readUntilTag("A1", { continuation: true })
        expect(items.map(i => i.line)).toEqual(["A1 APPEND INBOX"])
        expect(tagged.line).toStartWith("+")
    })

    test("does not mistake A10 for tag A1", async () => {
        const s = new ImapStream(toStream(["A10 OK wrong tag\r\n", "A1 OK right tag\r\n"]).getReader())
        const { items } = await s.readUntilTag("A1")
        expect(items.map(i => i.line)).toEqual(["A10 OK wrong tag"])
    })


    test("reassembles a large literal delivered in many small chunks", async () => {
        // 512 KiB in 4 KiB chunks — the shape that made the old
        // copy-per-chunk buffering quadratic.
        const size = 512 * 1024
        const payload = new Uint8Array(size)
        for (let i = 0; i < size; i++) payload[i] = i % 251
        const chunks: (string | Uint8Array)[] = [`* 1 FETCH (BODY[] {${size}}\r\n`]
        for (let pos = 0; pos < size; pos += 4096) {
            chunks.push(payload.subarray(pos, Math.min(pos + 4096, size)))
        }
        chunks.push(")\r\n")

        const s = new ImapStream(toStream(chunks).getReader())
        const item = await s.readItem()
        expect(item.literal!.length).toBe(size)
        expect(item.literal).toEqual(payload)
        const close = await s.readItem()
        expect(close.line).toBe(")")
    })

    test("keeps parsing correctly after a literal larger than the shrink threshold", async () => {
        const size = (1 << 20) + 4096
        const payload = new Uint8Array(size).fill(0x61)
        const s = new ImapStream(toStream([
            `* 1 FETCH (BODY[] {${size}}\r\n`,
            payload,
            ")\r\n",
            "* 2 EXISTS\r\n"
        ]).getReader())
        const item = await s.readItem()
        expect(item.literal!.length).toBe(size)
        expect((await s.readItem()).line).toBe(")")
        expect((await s.readItem()).line).toBe("* 2 EXISTS")
    })

    test("handles many lines and literals arriving in one chunk", async () => {
        const s = new ImapStream(toStream([
            "* 1 EXISTS\r\n* 2 FETCH (BODY[] {3}\r\nabc)\r\n* 3 EXISTS\r\n"
        ]).getReader())
        expect((await s.readItem()).line).toBe("* 1 EXISTS")
        const lit = await s.readItem()
        expect(new TextDecoder().decode(lit.literal)).toBe("abc")
        expect((await s.readItem()).line).toBe(")")
        expect((await s.readItem()).line).toBe("* 3 EXISTS")
    })

    test("handles a CRLF split across chunks after earlier consumed data", async () => {
        const s = new ImapStream(toStream([
            "* 1 EXISTS\r\n* 2 EXI",
            "STS\r",
            "\n* 3 EXISTS\r\n"
        ]).getReader())
        expect((await s.readItem()).line).toBe("* 1 EXISTS")
        expect((await s.readItem()).line).toBe("* 2 EXISTS")
        expect((await s.readItem()).line).toBe("* 3 EXISTS")
    })

    test("times out when the server never responds", async () => {
        const s = new ImapStream(new ReadableStream({ pull() {} }).getReader(), 50)
        await expect(s.readItem()).rejects.toThrow(/timed out/)
    })

    test("throws when the connection closes", async () => {
        const s = new ImapStream(new ReadableStream({ start(controller) { controller.close() } }).getReader())
        await expect(s.readItem()).rejects.toThrow(/closed by server/)
    })
})
