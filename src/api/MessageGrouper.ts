import type {Message} from "../types/message";
import {Accessor, createSignal, Setter, type Signal} from "solid-js";
import {createStore, reconcile, type SetStoreFunction} from "solid-js/store";
import {humanizeDate, isSameDay, snowflakes} from "../utils";
import type Api from "./Api";
import {User} from "../types/user";

/**
 * A divider between messages.
 */
export interface MessageDivider {
  isDivider: true
  /**
   * The content of the divider.
   */
  content: string
}

export type MessageGroup = Message[] & { isDivider?: false } | MessageDivider

/**
 * Difference in snowflakes within 15 minutes.
 */
export const SNOWFLAKE_BOUNDARY: bigint = BigInt(235_929_600_000)

const MESSAGE_HISTORY_LIMIT = 100

export function authorDefault(): User {
  return {
    id: BigInt(0),
    username: 'Unknown User',
    display_name: null,
    flags: 0,
  }
}

/**
 * Group an array of messages by author and day.
 */
function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let last: Message | undefined

  for (const message of messages) {
    const timestamp = snowflakes.timestamp(message.id)

    if (!last) {
      groups.push([message])
      last = message
      continue
    }

    const lastTimestamp = snowflakes.timestamp(last.id)
    const newDay = !isSameDay(timestamp, lastTimestamp)
    const shouldSplit = newDay
      || message.author_id !== last.author_id
      || message.id - last.id > SNOWFLAKE_BOUNDARY
      || !!message.references?.length

    if (newDay)
      groups.push({ isDivider: true, content: humanizeDate(timestamp) })

    if (shouldSplit)
      groups.push([message])
    else
      (<Message[]>groups[groups.length - 1]).push(message)

    last = message
  }

  return groups
}

/**
 * Groups messages by their author and timestamp.
 */
export default class MessageGrouper {
  private readonly messagesSignal: Signal<Message[]>
  private groupsValue: MessageGroup[]
  private setGroupsValue: SetStoreFunction<MessageGroup[]>
  private fetchBefore?: bigint
  private fetchLock = false
  private loading: Accessor<boolean>
  private setLoading: Setter<boolean>
  nonced: Map<string, number>
  noMoreMessages: Accessor<boolean>
  private setNoMoreMessages: Setter<boolean>
  private oldestMessageId?: Accessor<bigint | undefined>
  private setOldestMessageId: Setter<bigint | undefined>
  private newestMessageId?: Accessor<bigint | undefined>
  private setNewestMessageId: Setter<bigint | undefined>
  private hasGap: Accessor<boolean>
  private setHasGap: Setter<boolean>
  private readonly messageIds: Set<bigint>

  constructor(
    private readonly api: Api,
    private readonly channelId: bigint,
  ) {
    this.messagesSignal = createSignal([] as Message[]);
    [this.groupsValue, this.setGroupsValue] = createStore([] as MessageGroup[]);
    this.nonced = new Map();
    this.messageIds = new Set();
    [this.noMoreMessages, this.setNoMoreMessages] = createSignal(false);
    [this.loading, this.setLoading] = createSignal(false);
    [this.oldestMessageId, this.setOldestMessageId] = createSignal<bigint | undefined>(undefined);
    [this.newestMessageId, this.setNewestMessageId] = createSignal<bigint | undefined>(undefined);
    [this.hasGap, this.setHasGap] = createSignal(false);
  }

  private recompute() {
    const messages = this.messages
    this.setGroupsValue(reconcile(groupMessages(messages)))
    this.updateMessageBoundaries(messages)
    this.checkForMessageGap(messages)
  }

  get isLoading() {
    return this.loading()
  }

  get hasMessageGap() {
    return this.hasGap()
  }

  get oldestLoaded() {
    return this.oldestMessageId?.()
  }

  get newestLoaded() {
    return this.newestMessageId?.()
  }

  /**
   * Update the oldest and newest message IDs after message insertion
   */
  private updateMessageBoundaries(messages: Message[]) {
    if (messages.length === 0) {
      this.setOldestMessageId(undefined)
      this.setNewestMessageId(undefined)
      return
    }

    this.setOldestMessageId(messages[0].id)
    this.setNewestMessageId(messages[messages.length - 1].id)
  }

  /**
   * Determines if there is a gap between the current message context and the newest loaded messages
   */
  checkForMessageGap(messages: Message[] = this.messages) {
    if (messages.length === 0) {
      this.setHasGap(false)
      return false
    }

    const oldestId = messages[0].id
    const newestId = messages[messages.length - 1].id
    const totalMessageCount = messages.length
    const expectedDiff = BigInt(totalMessageCount * 2)
    const actualDiff = newestId - oldestId

    const hasGap = actualDiff > expectedDiff && actualDiff > BigInt(MESSAGE_HISTORY_LIMIT * 3)
    this.setHasGap(hasGap)
    return hasGap
  }

  /**
   * Gets the total number of actual messages (excluding dividers)
   */
  getTotalMessageCount(): number {
    return this.messages.length
  }

  /**
   * Pushes a message into the store and returns its index.
   */
  pushMessage(message: Message): number {
    if (this.messageIds.has(message.id))
      return this.messages.findIndex(m => m.id === message.id)

    let index = 0
    this.setMessages(prev => {
      const next = [...prev]
      // Fast paths: append or prepend
      if (next.length === 0 || message.id > next[next.length - 1].id) {
        next.push(message)
        index = next.length - 1
      } else if (message.id < next[0].id) {
        next.unshift(message)
        index = 0
      } else {
        // Binary search insertion index
        let lo = 0, hi = next.length - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (next[mid].id < message.id) lo = mid + 1
          else hi = mid - 1
        }
        next.splice(lo, 0, message)
        index = lo
      }
      return next
    })
    this.messageIds.add(message.id)
    if (index === this.messages.length - 1) {
      this.appendMessageToGroups(message)
      this.updateMessageBoundaries(this.messages)
      this.checkForMessageGap(this.messages)
    } else if (index === 0) {
      this.prependMessageToGroups(message)
      this.updateMessageBoundaries(this.messages)
      this.checkForMessageGap(this.messages)
    } else {
      this.recompute()
    }
    return index
  }

  /**
   * Inserts messages from the API into the grouper.
   *
   * This assumes that messages are ordered by timestamp, oldest to newest. It also assumes that the messages do not
   * overlap.
   */
  insertMessages(messages: Message[]) {
    const unique = messages.filter(m => !this.messageIds.has(m.id))
    if (unique.length === 0) return

    unique.forEach(m => this.messageIds.add(m.id))
    let prevTail: Message | undefined
    let prevHead: Message | undefined
    this.setMessages(prev => {
      prevTail = prev[prev.length - 1]
      prevHead = prev[0]
      if (prev.length === 0) return [...unique]
      // Since API guarantees chunks are ordered and non-overlapping with what we request,
      // try fast path merge; otherwise fallback to linear merge.
      const uFirst = unique[0].id
      const uLast = unique[unique.length - 1].id
      const pFirst = prev[0].id
      const pLast = prev[prev.length - 1].id

      if (uLast < pFirst) {
        // Entire chunk goes before current
        return [...unique, ...prev]
      } else if (uFirst > pLast) {
        // Entire chunk goes after current
        return [...prev, ...unique]
      } else {
        // General merge
        const merged: Message[] = []
        let i = 0, j = 0
        while (i < prev.length && j < unique.length) {
          if (prev[i].id < unique[j].id) merged.push(prev[i++])
          else merged.push(unique[j++])
        }
        while (i < prev.length) merged.push(prev[i++])
        while (j < unique.length) merged.push(unique[j++])
        return merged
      }
    })

    const appended = prevTail && unique[0].id > prevTail.id
    const prepended = prevHead && unique[unique.length - 1].id < prevHead.id
    if (appended) {
      this.appendChunkToGroups(unique, prevTail!)
      this.updateMessageBoundaries(this.messages)
      this.checkForMessageGap(this.messages)
    } else if (prepended) {
      this.prependChunkToGroups(unique, prevHead!)
      this.updateMessageBoundaries(this.messages)
      this.checkForMessageGap(this.messages)
    } else {
      this.recompute()
    }
  }

  /**
   * Removes a message from the grouper.
   */
  removeMessage(id: bigint) {
    if (!this.messageIds.has(id)) return
    this.messageIds.delete(id)
    this.setMessages(prev => prev.filter(m => m.id !== id))
    this.recompute()
  }

  /**
   * Retrieves the latest message that satisfies the given predicate within all messages cached by the grouper.
   */
  latestMessageWhere(predicate: (message: Message) => boolean): Message | undefined {
    const messages = this.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (predicate(message)) return message
    }
    return undefined
  }

  private findGroupMessageIndex(id: bigint): [number, number] | null {
    const groups = this.groups
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]
      if (group.isDivider) continue
      const mi = group.findIndex(m => m.id === id)
      if (mi !== -1) return [gi, mi]
    }
    return null
  }

  /**
   * Finds the indices of the message with the highest ID but still at most the given message ID.
   */
  findCloseMessageIndex(id: bigint): [number, number] {
    return this.findGroupMessageIndex(id) ?? [-1, -1]
  }

  /**
   * Finds a message by ID and scrolls to it, loading surrounding messages if needed
   */
  async findMessage(id: bigint): Promise<[number, number] | null> {
    const loc = this.findGroupMessageIndex(id)
    if (loc) return loc

    await this.fetchMessages(id)

    return this.findGroupMessageIndex(id)
  }

  /**
   * Fetches messages from the API and inserts into the grouper.
   * @param targetId If provided, fetch messages around this ID
   * @param after If true, fetch messages after the provided targetId or last loaded message
   * @param before If true, fetch messages before the provided targetId
   */
  async fetchMessages(targetId?: bigint, after?: boolean, before?: boolean) {
    if (this.fetchLock)
      return

    this.fetchLock = true
    this.setLoading(true)
    const params: Record<string, any> = { limit: MESSAGE_HISTORY_LIMIT }

    if (targetId) {
      if (after) {
        params.after = targetId
      } else if (before) {
        params.before = targetId
      } else {
        params.around = targetId
      }
    } else if (after) {
      const lastMessage = this.messages[this.messages.length - 1]
      if (lastMessage) {
        params.after = lastMessage.id
      } else {
        this.fetchLock = false
        this.setLoading(false)
        return
      }
    } else if (this.fetchBefore != null) {
      params.before = this.fetchBefore
    }

    try {
      const response = await this.api.request<Message[]>('GET', `/channels/${this.channelId}/messages`, { params })
      const messages = response.ensureOk().jsonOrThrow()

      if (messages.length === 0) {
        this.fetchLock = false
        this.setLoading(false)
        this.setNoMoreMessages(true)
        return
      }

      if (!targetId && !after && !before) {
        this.fetchBefore = messages[messages.length - 1]?.id
        if (messages.length < MESSAGE_HISTORY_LIMIT)
          this.setNoMoreMessages(true)
      }

      this.insertMessages(messages.reverse())
    } finally {
      this.fetchLock = false
      this.setLoading(false)
    }
  }

  /**
   * Fetches the next chunk of messages to fill the gap between contexts
   */
  async fetchNextChunk() {
    if (!this.oldestLoaded || !this.newestLoaded) return

    const totalMessageCount = this.getTotalMessageCount()

    if (totalMessageCount < 50) {
      await this.fetchMessages(this.oldestLoaded, true)
    } else {
      await this.fetchMessages(this.newestLoaded, false, false)
    }
  }

  /**
   * Fetches the latest messages to jump to bottom
   */
  async fetchLatestMessages() {
    this.setMessages([])
    this.messageIds.clear()
    this.fetchBefore = undefined
    await this.fetchMessages()
  }

  get messages() {
    return this.messagesSignal[0]()
  }

  private get setMessages() {
    return this.messagesSignal[1]
  }

  get groups() {
    return this.groupsValue
  }

  // setGroupsValue used for updates

  private isDivider(group: MessageGroup): group is MessageDivider {
    return (group as any)?.isDivider === true
  }

  private isNewDay(prev: Message | undefined, curr: Message): boolean {
    if (!prev) return false
    const prevTs = snowflakes.timestamp(prev.id)
    const currTs = snowflakes.timestamp(curr.id)
    return !isSameDay(prevTs, currTs)
  }

  private shouldSplitAcross(prev: Message | undefined, curr: Message): boolean {
    if (!prev) return true
    const newDay = this.isNewDay(prev, curr)
    return newDay
      || curr.author_id !== prev.author_id
      || curr.id - prev.id > SNOWFLAKE_BOUNDARY
      || !!curr.references?.length
  }

  private appendMessageToGroups(message: Message) {
    const prevMsg = this.messages[this.messages.length - 2]
    const newDay = this.isNewDay(prevMsg, message)
    const split = this.shouldSplitAcross(prevMsg, message)
    const ts = snowflakes.timestamp(message.id)

    this.setGroupsValue(prevGroups => {
      const next = [...prevGroups]
      if (newDay) next.push({ isDivider: true, content: humanizeDate(ts) })
      if (next.length === 0 || split || this.isDivider(next[next.length - 1])) {
        next.push([message])
      } else {
        const li = next.length - 1
        const arr = next[li] as Message[]
        next[li] = [...arr, message]
      }
      return next
    })
  }

  private prependMessageToGroups(message: Message) {
    const nextMsg = this.messages[1]
    const newDay = this.isNewDay(message, nextMsg)
    const split = this.shouldSplitAcross(message, nextMsg)
    const ts = snowflakes.timestamp(message.id)

    this.setGroupsValue(prevGroups => {
      const next = [...prevGroups]
      if (newDay && split) {
        next.unshift([message])
        next.splice(1, 0, { isDivider: true, content: humanizeDate(ts) })
        return next
      }
      if (next.length > 0 && !this.isDivider(next[0]) && !split) {
        const arr = next[0] as Message[]
        next[0] = [message, ...arr]
        return next
      }
      next.unshift([message])
      return next
    })
  }

  private appendChunkToGroups(unique: Message[], prevTail: Message) {
    if (unique.length === 0) return
    const first = unique[0]
    const tsFirst = snowflakes.timestamp(first.id)
    const needDivider = this.isNewDay(prevTail, first)
    const splitBoundary = this.shouldSplitAcross(prevTail, first)
    const newGroups = groupMessages(unique)

    this.setGroupsValue(prevGroups => {
      const next = [...prevGroups]
      if (needDivider) {
        next.push({ isDivider: true, content: humanizeDate(tsFirst) })
        return [...next, ...newGroups]
      }
      // Try to merge first new group with last existing group
      if (!splitBoundary && next.length > 0) {
        const lastIdx = next.length - 1
        const lastIsDivider = this.isDivider(next[lastIdx])
        const mergeTargetIdx = lastIsDivider ? lastIdx - 1 : lastIdx
        if (mergeTargetIdx >= 0 && !this.isDivider(next[mergeTargetIdx]) && !this.isDivider(newGroups[0])) {
          const merged = [...(next[mergeTargetIdx] as Message[]), ...(newGroups[0] as Message[])]
          next[mergeTargetIdx] = merged
          return [...next, ...newGroups.slice(1)]
        }
      }
      return [...next, ...newGroups]
    })
  }

  private prependChunkToGroups(unique: Message[], oldHead: Message) {
    if (unique.length === 0) return
    const last = unique[unique.length - 1]
    const tsNext = snowflakes.timestamp(oldHead.id)
    const needDivider = this.isNewDay(last, oldHead)
    const splitBoundary = this.shouldSplitAcross(last, oldHead)
    const newGroups = groupMessages(unique)

    this.setGroupsValue(prevGroups => {
      const next = [...prevGroups]
      if (needDivider) {
        return [...newGroups, { isDivider: true, content: humanizeDate(tsNext) }, ...next]
      }
      if (!splitBoundary && next.length > 0 && !this.isDivider(newGroups[newGroups.length - 1]) && !this.isDivider(next[0])) {
        const mergedLast = [...(newGroups[newGroups.length - 1] as Message[]), ...(next[0] as Message[])]
        const head = newGroups.slice(0, -1)
        return [...head, mergedLast, ...next.slice(1)]
      }
      return [...newGroups, ...next]
    })
  }

  get nonceDefault(): Partial<Message> {
    return {
      channel_id: this.channelId,
      embeds: [],
      flags: 0,
      reactions: [],
      edited_at: null,
      mentions: [],
      references: [],
    }
  }

  editMessage(id: bigint, message: Message) {
    this.setMessages(prev => {
      const next = [...prev]
      const idx = next.findIndex(m => m.id === id)
      if (idx >= 0) next[idx] = message
      return next
    })
    if (this.messageIds.has(id)) {
      this.messageIds.delete(id)
      this.messageIds.add(message.id)
    }
    this.recompute()
  }

  private ackNonceWith(nonce: string, message: Message, f: (message: Message) => void) {
    const idx = this.nonced.get(nonce)!
    this.nonced.delete(nonce)
    const oldId = this.messages[idx].id

    this.setMessages(prev => {
      const next = [...prev]
      Object.assign(next[idx], message)
      f(next[idx])
      return next
    })
    this.messageIds.delete(oldId)
    this.messageIds.add(message.id)
    this.recompute()
  }

  /**
   * Acks the nonce of a message.
   */
  ackNonce(nonce: string, message: Message) {
    this.ackNonceWith(nonce, message, m => m._nonceState = 'success')
  }

  /**
   * Acks the nonce of a message with an error.
   */
  ackNonceError(nonce: string, message: Message, error: string) {
    this.ackNonceWith(nonce, message, m => {
      m._nonceState = 'error'
      m._nonceError = error
    })
  }
}
