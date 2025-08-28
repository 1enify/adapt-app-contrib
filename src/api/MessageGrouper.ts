import type {Message} from "../types/message";
import {Accessor, createSignal, Setter, type Signal} from "solid-js";
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
  private readonly groupsSignal: Signal<MessageGroup[]>
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
    this.groupsSignal = createSignal([] as MessageGroup[]);
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
    this.setGroups(groupMessages(messages))
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
      const next = [...prev, message]
      next.sort((a, b) => (a.id < b.id ? -1 : 1))
      index = next.findIndex(m => m.id === message.id)
      return next
    })
    this.messageIds.add(message.id)
    this.recompute()
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
    this.setMessages(prev => {
      const next = [...prev, ...unique]
      next.sort((a, b) => (a.id < b.id ? -1 : 1))
      return next
    })
    this.recompute()
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
    return this.groupsSignal[0]()
  }

  private get setGroups() {
    return this.groupsSignal[1]
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

