import { describe, expect, test } from "bun:test"
import {
    decodeMimeEncodedWords,
    decodeBytes,
    base64ToBytes,
    bytesToBase64,
    decodeQuotedPrintable
} from "../src/utils/decodeMime"

describe("decodeMimeEncodedWords", () => {
    test("decodes base64 encoded word", () => {
        expect(decodeMimeEncodedWords("=?utf-8?B?SGVsbG8gV29ybGQ=?=")).toBe("Hello World")
    })

    test("decodes Q encoded word with underscores", () => {
        expect(decodeMimeEncodedWords("=?utf-8?Q?Hello_World?=")).toBe("Hello World")
    })

    test("decodes Q encoded word with hex escapes", () => {
        expect(decodeMimeEncodedWords("=?utf-8?Q?J=C3=A4rjestys?=")).toBe("Järjestys")
    })

    test("decodes latin-1 base64 word", () => {
        expect(decodeMimeEncodedWords("=?iso-8859-1?B?SuRy?=")).toBe("Jär")
    })

    test("joins adjacent encoded words without whitespace", () => {
        expect(decodeMimeEncodedWords("=?utf-8?B?SGVsbG8=?= =?utf-8?B?V29ybGQ=?=")).toBe("HelloWorld")
    })

    test("keeps whitespace between encoded word and plain text", () => {
        expect(decodeMimeEncodedWords("Hello =?utf-8?B?V29ybGQ=?= again")).toBe("Hello World again")
    })

    test("returns input unchanged when no encoded words", () => {
        expect(decodeMimeEncodedWords("plain text")).toBe("plain text")
    })
})

describe("base64", () => {
    test("roundtrip", () => {
        const bytes = new TextEncoder().encode("Hello, World! 123")
        expect(bytesToBase64(base64ToBytes(bytesToBase64(bytes)))).toBe(bytesToBase64(bytes))
    })

    test("handles whitespace in input", () => {
        expect(new TextDecoder().decode(base64ToBytes("SGVs\r\nbG8="))).toBe("Hello")
    })
})

describe("decodeQuotedPrintable", () => {
    test("decodes hex escapes", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("J=C3=A4rjestys"))).toBe("Järjestys")
    })

    test("removes soft line breaks", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("soft=\r\nbreak"))).toBe("softbreak")
    })

    test("keeps literal equals", () => {
        expect(new TextDecoder().decode(decodeQuotedPrintable("a=b"))).toBe("a=b")
    })
})

describe("decodeBytes", () => {
    test("utf-8", () => {
        expect(decodeBytes(new TextEncoder().encode("héllo"))).toBe("héllo")
    })

    test("latin-1 high bytes map directly", () => {
        const bytes = Uint8Array.from([0x4a, 0x65, 0x6d, 0xe4, 0x72])
        expect(decodeBytes(bytes, "iso-8859-1")).toBe("Jemär")
    })

    test("windows-1252 maps smart quotes", () => {
        const bytes = Uint8Array.from([0x93, 0x68, 0x69, 0x94])
        expect(decodeBytes(bytes, "windows-1252")).toBe("\u201Chi\u201D")
    })

    test("unknown charset falls back to latin-1", () => {
        const bytes = Uint8Array.from([0x61, 0xe4])
        expect(decodeBytes(bytes, "x-mystery-charset")).toBe("aä")
    })

    test("iso-8859-15 decodes the euro sign, not a currency sign", () => {
        // 0xA4 is € in ISO-8859-15 but ¤ in ISO-8859-1
        const bytes = Uint8Array.from([0x34, 0x32, 0xa4])
        expect(decodeBytes(bytes, "iso-8859-15")).toBe("42€")
        expect(decodeBytes(bytes, "ISO_8859-15")).toBe("42€")
    })

    test("iso-8859-15 keeps the codepoints it shares with latin-1", () => {
        const bytes = Uint8Array.from([0x4a, 0x65, 0x6d, 0xe4, 0x72])
        expect(decodeBytes(bytes, "iso-8859-15")).toBe("Jemär")
    })

    test("other iso-8859 variants are not decoded as latin-1", () => {
        // 0xE1 is α in ISO-8859-7 (Greek) but á in ISO-8859-1
        expect(decodeBytes(Uint8Array.from([0xe1]), "iso-8859-7")).toBe("α")
    })

    test("koi8 is not decoded as latin-1", () => {
        // 0xC1 is Cyrillic а in KOI8-U but Á in ISO-8859-1
        expect(decodeBytes(Uint8Array.from([0xc1]), "koi8-u")).toBe("а")
    })

    test("iso-8859-2 decodes correctly where the runtime's TextDecoder supports it", () => {
        // 0xB1 is ą in ISO-8859-2 but ± in ISO-8859-1. Not every runtime
        // ships every WHATWG encoding (workerd and Node do); where it is
        // missing, decodeBytes keeps its documented latin-1 fallback.
        let supported = true
        try {
            new TextDecoder("iso-8859-2")
        } catch {
            supported = false
        }
        const decoded = decodeBytes(Uint8Array.from([0xb1]), "iso-8859-2")
        expect(decoded).toBe(supported ? "ą" : "±")
    })
})
