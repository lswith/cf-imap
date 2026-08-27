export type ResponseItem = {
    line: string,
    /** Literal data if the line ended with a {N} marker, null otherwise */
    literal: Uint8Array | null
}

export class ImapError extends Error {
    status: "OK" | "NO" | "BAD"
    tag: string
    messageText: string
    untagged: ResponseItem[]

    constructor(status: "OK" | "NO" | "BAD", tag: string, messageText: string, untagged: ResponseItem[]) {
        super(`IMAP ${status} (${tag}): ${messageText}`)
        this.name = "ImapError"
        this.status = status
        this.tag = tag
        this.messageText = messageText
        this.untagged = untagged
    }
}

/**
 * Reads IMAP responses from a socket's readable stream.
 *
 * Handles:
 * - Responses split across arbitrary TCP chunks
 * - Literals ({N} markers) whose content may span multiple chunks and
 *   contain CRLF, parens or any other bytes
 * - Multi-byte UTF-8 sequences split across chunk boundaries
 */
const INITIAL_CAPACITY = 4096
// Above this, an emptied buffer is reallocated small again so one large
// literal does not pin its peak allocation for the connection's lifetime.
const SHRINK_THRESHOLD = 1 << 20

export class ImapStream {
    private reader: ReadableStreamDefaultReader<any>
    /**
     * Growable receive buffer. The live (unconsumed) region is
     * [start, end); appends double the capacity when needed rather than
     * reallocating per chunk, so buffering a literal is O(n) amortized in
     * its size instead of O(n²).
     */
    private buffer = new Uint8Array(INITIAL_CAPACITY)
    private start = 0
    private end = 0
    /** Position up to which the CRLF scan has already looked, so refills don't rescan. */
    private scanPos = 0
    private textDecoder = new TextDecoder()
    private timeoutMs: number
    /**
     * The in-flight reader.read() promise. Never issue a second read() while
     * one is pending (the stream throws); on a read timeout the pending
     * promise is kept here and reused by the next read, so its data is never
     * lost and the stream stays consistent.
     */
    private pendingRead: Promise<ReadableStreamReadResult<any>> | null = null

    constructor(reader: ReadableStreamDefaultReader<any>, timeoutMs = 30000) {
        this.reader = reader
        this.timeoutMs = timeoutMs
    }

    private nextRead(): Promise<ReadableStreamReadResult<any>> {
        if (!this.pendingRead) {
            const read = this.reader.read()
            this.pendingRead = read.catch(e => {
                this.pendingRead = null
                throw e
            })
        }
        return this.pendingRead
    }

    /** Reads one chunk from the socket, waiting up to timeoutMs. */
    private async readChunk(): Promise<ReadableStreamReadResult<any> | "timeout"> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<"timeout">(resolve => {
            timer = setTimeout(() => resolve("timeout"), this.timeoutMs)
        })
        try {
            const result = await Promise.race([this.nextRead(), timeout])
            if (result === "timeout") return "timeout"
            this.pendingRead = null
            return result
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    private async fillBuffer(): Promise<void> {
        const result = await this.readChunk()
        if (result === "timeout") {
            this.close()
            throw new Error(`IMAP read timed out after ${this.timeoutMs}ms`)
        }
        this.appendChunk(result)
    }

    /** Like fillBuffer, but returns false on timeout instead of closing the reader. */
    private async fillBufferNoThrow(): Promise<boolean> {
        const result = await this.readChunk()
        if (result === "timeout") return false
        this.appendChunk(result)
        return true
    }

    private get available(): number {
        return this.end - this.start
    }

    private appendChunk(result: ReadableStreamReadResult<any>): void {
        if (result.done) throw new Error("IMAP connection closed by server")
        const chunk: Uint8Array = result.value
        this.ensureRoom(chunk.length)
        this.buffer.set(chunk, this.end)
        this.end += chunk.length
    }

    /**
     * Makes room to append n bytes: compacts the live region to the front
     * when the consumed prefix alone frees enough space, and otherwise grows
     * the capacity by doubling.
     */
    private ensureRoom(n: number): void {
        if (this.end + n <= this.buffer.length) return
        const len = this.available
        if (len + n <= this.buffer.length) {
            this.buffer.copyWithin(0, this.start, this.end)
        } else {
            let capacity = this.buffer.length
            while (capacity < len + n) capacity *= 2
            const next = new Uint8Array(capacity)
            next.set(this.buffer.subarray(this.start, this.end))
            this.buffer = next
        }
        this.scanPos -= this.start
        this.end = len
        this.start = 0
    }

    /** Marks [start, consumedTo) consumed and resets the buffer when it empties. */
    private consumeTo(consumedTo: number): void {
        this.start = consumedTo
        this.scanPos = consumedTo
        if (this.start === this.end) {
            this.start = 0
            this.end = 0
            this.scanPos = 0
            if (this.buffer.length > SHRINK_THRESHOLD) this.buffer = new Uint8Array(INITIAL_CAPACITY)
        }
    }

    private indexOfCRLF(): number {
        for (let i = Math.max(this.start, this.scanPos); i < this.end - 1; i++) {
            if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) return i
        }
        // Next scan may start at the last byte (it could be the CR of a pair
        // completed by the next chunk), never earlier.
        this.scanPos = Math.max(this.start, this.end - 1)
        return -1
    }

    private close(): void {
        try {
            this.reader.cancel()
        } catch { /* already closed */ }
    }

    /**
     * Reads the next protocol element: either a plain line, or a line ending
     * with a {N} literal marker together with the N raw literal bytes.
     */
    async readItem(): Promise<ResponseItem> {
        const item = await this.readItemInternal(false)
        return item!
    }

    /**
     * Like readItem, but a read timeout while waiting for a line is not fatal:
     * returns null instead (the reader is NOT cancelled, the stream stays
     * usable). Timeouts while waiting for literal bytes are still fatal — a
     * partially-consumed literal leaves the stream corrupt. Used by IDLE,
     * where silence between responses is normal.
     */
    async readItemNoThrow(): Promise<ResponseItem | null> {
        return this.readItemInternal(true)
    }

    private async readItemInternal(noThrow: boolean): Promise<ResponseItem | null> {
        for (;;) {
            const idx = this.indexOfCRLF()
            if (idx !== -1) {
                const line = this.textDecoder.decode(this.buffer.subarray(this.start, idx), { stream: true })
                this.consumeTo(idx + 2)

                const marker = /\{(\d+)\+?\}$/.exec(line)
                if (marker) {
                    const n = parseInt(marker[1])
                    if (n === 0) return { line, literal: new Uint8Array(0) }
                    while (this.available < n) await this.fillBuffer()
                    const literal = this.buffer.slice(this.start, this.start + n)
                    this.consumeTo(this.start + n)
                    return { line, literal }
                }

                return { line, literal: null }
            }
            if (noThrow) {
                if (!(await this.fillBufferNoThrow())) return null
            } else {
                await this.fillBuffer()
            }
        }
    }

    /**
     * Reads items until the tagged completion response (tag OK/NO/BAD) arrives.
     * With continuation: true, stops at the first "+ " continuation line
     * instead (used for literal uploads).
     */
    async readUntilTag(tag: string, opts: { continuation?: boolean } = {}): Promise<{ items: ResponseItem[], tagged: ResponseItem }> {
        const items: ResponseItem[] = []

        for (;;) {
            const item = await this.readItem()
            const line = item.line

            if (opts.continuation && line.startsWith("+")) {
                return { items, tagged: item }
            }

            if (line.startsWith(`${tag} `)) {
                const rest = line.slice(tag.length).trim()
                const m = /^(OK|NO|BAD)(?: (.*))?$/.exec(rest)
                if (m) {
                    if (m[1] === "OK") return { items, tagged: item }
                    throw new ImapError(m[1] as "NO" | "BAD", tag, m[2] ?? "", items)
                }
            }

            items.push(item)
        }
    }
}
