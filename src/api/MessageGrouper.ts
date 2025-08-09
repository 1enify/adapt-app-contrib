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

/**
 * Shortcut function for getting the last element of an array.
 */
function last<T>(array: T[]): T | undefined {
  return array[array.length - 1]
}

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
 * Groups messages by their author and timestamp.
 */
export default class MessageGrouper {
  private readonly groupsSignal: Signal<MessageGroup[]>
  private currentGroup?: Message[]
  private fetchBefore?: bigint
  private fetchLock: boolean = false
  private loading: Accessor<boolean>
  private setLoading: Setter<boolean>
  nonced: Map<string, [number, number]>
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
    this.groupsSignal = createSignal([] as MessageGroup[])
    this.nonced = new Map();
    this.messageIds = new Set();
    [this.noMoreMessages, this.setNoMoreMessages] = createSignal(false);
    [this.loading, this.setLoading] = createSignal(false);
    [this.oldestMessageId, this.setOldestMessageId] = createSignal<bigint | undefined>(undefined);
    [this.newestMessageId, this.setNewestMessageId] = createSignal<bigint | undefined>(undefined);
    [this.hasGap, this.setHasGap] = createSignal(false);
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
  private updateMessageBoundaries() {
    let oldestId: bigint | undefined;
    let newestId: bigint | undefined;

    for (const group of this.groups) {
      if (group.isDivider) continue;
      
      for (const message of group) {
        if (!oldestId || message.id < oldestId) {
          oldestId = message.id;
        }
        if (!newestId || message.id > newestId) {
          newestId = message.id;
        }
      }
    }

    this.setOldestMessageId(oldestId);
    this.setNewestMessageId(newestId);
  }

  /**
   * Determines if there is a gap between the current message context and the newest loaded messages
   */
  checkForMessageGap() {
    if (!this.oldestLoaded || !this.newestLoaded) {
      this.setHasGap(false);
      return false;
    }

    // If the difference between newest and oldest is significantly larger than the loaded message count would suggest,
    // then we likely have a gap
    const totalMessageCount = this.getTotalMessageCount();
    const expectedDiff = BigInt(totalMessageCount * 2); // rough estimate assuming uniform message ID distribution
    const actualDiff = this.newestLoaded - this.oldestLoaded;
    
    const hasGap = actualDiff > expectedDiff && actualDiff > BigInt(MESSAGE_HISTORY_LIMIT * 3);
    this.setHasGap(hasGap);
    return hasGap;
  }

  /**
   * Gets the total number of actual messages (excluding dividers)
   */
  getTotalMessageCount(): number {
    return this.groups.reduce((count, group) => {
      if (group.isDivider) return count;
      return count + group.length;
    }, 0);
  }

  /**
   * Pushes a message into the timestamp.
   */
  pushMessage(message: Message): [number, number] {
    if (this.messageIds.has(message.id)) return this.findCloseMessageIndex(message.id)

    if (this.currentGroup == null) this.finishGroup()
    const behavior = this.nextMessageBehavior({ message })

    if (behavior)
      this.finishGroup(behavior === true ? undefined : behavior)

    this.setGroups(prev => {
      let groups = [...prev]
      groups[groups.length - 1] = this.currentGroup = [...this.currentGroup!, message]
      return groups
    })
 this.messageIds.add(message.id)
    return [this.groups.length - 1, this.currentGroup!.length - 1]
  }

  /**
   * Removes a message from the grouper.
   */
  removeMessage(id: bigint) {
    const [groupIndex, messageIndex] = this.findCloseMessageIndex(id)
    if (groupIndex < 0) return

    this.setGroups(prev => {
      let groups = [...prev]
      let group = [...<Message[]> groups[groupIndex]]
      group.splice(messageIndex, 1)
      groups[groupIndex] = group
      if (group.length === 0) groups.splice(groupIndex, 1)
      return groups
    })
 this.messageIds.delete(id)
  }

  /**
   * Finds the indices of the message with the highest ID but still at most the given message ID.
   */
  findCloseMessageIndex(id: bigint): [number, number] {
    let groupIndex = this.groups.length - 1
    let messageIndex = 0

    const updateGroupIndex = () => {
      const lastGroup = this.groups[groupIndex]
      messageIndex = lastGroup.isDivider ? 0 : lastGroup.length - 1
    }
    updateGroupIndex()

    while (groupIndex >= 0 && messageIndex >= 0) {
      const group = this.groups[groupIndex]
      if (group.isDivider) {
        groupIndex--
        updateGroupIndex()
        continue
      }

      const message = group[messageIndex]
      if (message.id <= id) break

      if (--messageIndex < 0) {
        if (--groupIndex < 0)
          return [-1, -1]

        updateGroupIndex()
      }
    }
    return [groupIndex, messageIndex]
  }

  /**
   * Inserts messages from the API into the grouper.
   *
   * This assumes that messages are ordered by timestamp, oldest to newest. It also assumes that the messages do not
   * overlap.
   */
  insertMessages(messages: Message[]) {
    if (messages.length === 0) return

    // Filter out messages that have already been inserted
    const uniqueMessages = messages.filter(message => !this.messageIds.has(message.id));

    if (uniqueMessages.length === 0) return

    let groups = this.groups
    if (this.currentGroup == null) groups.push([])

    let [groupIndex, messageIndex] = this.findCloseMessageIndex(uniqueMessages[0].id)
    let lastMessage: Message | undefined

    if (groupIndex <= 0) {
      let firstMessageGroup = groups[0]
      if (firstMessageGroup?.isDivider || groupIndex < 0)
        groups = [firstMessageGroup = [], ...groups]

      // Only set lastMessage if the group actually has messages
      if (firstMessageGroup.length > 0) {
        lastMessage = firstMessageGroup[0]
      }
      groupIndex = 0
    } else {
      lastMessage = (<Message[]> groups[groupIndex])[messageIndex]
    }

    for (const message of uniqueMessages) {
      // Skip divider logic for the first message if we don't have a previous message for reference
      const behavior = lastMessage 
        ? this.nextMessageBehavior({ lastMessage, message }) 
        : false

      if (behavior) {
        if (behavior !== true) {
          // Only add a divider if the dates are actually different
          const messageDate = new Date(snowflakes.timestamp(message.id)).toDateString()
          const lastMessageDate = new Date(snowflakes.timestamp(lastMessage!.id)).toDateString()
          
          if (messageDate !== lastMessageDate) {
            groups.splice(++groupIndex, 0, behavior)
          }
        }
        groups.splice(++groupIndex, 0, [])
        messageIndex = -1
      }

      const target = <Message[]> groups[groupIndex]
      target.splice(++messageIndex, 0, message)
 this.messageIds.add(message.id)
      lastMessage = message
    }

    this.setGroups([...groups])
    this.currentGroup = last(groups) as any
    
    // Update oldest and newest message IDs after inserting messages
    this.updateMessageBoundaries();
    
    // Check if we have a gap in message history
    this.checkForMessageGap();
  }

  /**
   * Finds a message by ID and scrolls to it, loading surrounding messages if needed
   */
  async findMessage(id: bigint): Promise<[number, number] | null> {
    // First check if we already have the message
    const [groupIndex, messageIndex] = this.findCloseMessageIndex(id)
    if (groupIndex >= 0) {
      const group = this.groups[groupIndex]
      if (!group.isDivider) {
        const message = group[messageIndex]
        if (message.id === id) {
          return [groupIndex, messageIndex]
        }
      }
    }

    // If we don't have the message, load messages around it
    await this.fetchMessages(id)
    
    // Check again after loading
    const [newGroupIndex, newMessageIndex] = this.findCloseMessageIndex(id)
    if (newGroupIndex >= 0) {
      const group = this.groups[newGroupIndex]
      if (!group.isDivider) {
        const message = group[newMessageIndex]
        if (message.id === id) {
          return [newGroupIndex, newMessageIndex]
        }
      }
    }

    return null
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
        // Fetch messages after the target ID
        params.after = targetId
      } else if (before) {
        // Fetch messages before the target ID
        params.before = targetId
      } else {
        // Fetch messages around the target ID
        params.around = targetId
      }
    } else if (after) {
      // Fetch messages after the oldest loaded message
      const lastGroup = this.groups[this.groups.length - 1]
      if (lastGroup && !lastGroup.isDivider && lastGroup.length > 0) {
        const lastMessage = lastGroup[lastGroup.length - 1]
        params.after = lastMessage.id
      } else {
        // If we have no messages, just return
        this.fetchLock = false
        this.setLoading(false)
        return
      }
    } else if (this.fetchBefore != null) {
      // Fetch messages before the oldest loaded message
      params.before = this.fetchBefore
    }

    try {
      const response = await this.api.request<Message[]>('GET', `/channels/${this.channelId}/messages`, { params })
      const messages = response.ensureOk().jsonOrThrow()

      if (messages.length === 0) {
        this.fetchLock = false
        this.setLoading(false)
        return
      }

      if (!targetId && !after && !before) {
        this.fetchBefore = last(messages)?.id
        if (messages.length < MESSAGE_HISTORY_LIMIT)
          this.setNoMoreMessages(true)
      }

      this.insertMessages(messages.reverse())
      
      // After inserting messages, check if we still have a gap
      this.checkForMessageGap();
    } finally {
      this.fetchLock = false
      this.setLoading(false)
    }
  }

  /**
   * Fetches the next chunk of messages to fill the gap between contexts
   */
  async fetchNextChunk() {
    if (!this.oldestLoaded || !this.newestLoaded) return;
    
    // Determine whether we should fetch messages after the oldest or before the newest
    // If the gap is closer to the oldest loaded message, fetch after the oldest
    // If the gap is closer to the newest loaded message, fetch before the newest
    
    const totalMessageCount = this.getTotalMessageCount();
    
    // If we have fewer than 50 messages loaded, we need to fetch more messages
    if (totalMessageCount < 50) {
      // If we're closer to the oldest message context (likely jumped to an old message)
      // then fetch messages after the oldest message to move forward in time
      await this.fetchMessages(this.oldestLoaded, true);
    } 
    // Otherwise, if we have a lot of old messages loaded (scrolled up a lot)
    // then fetch newer messages to move toward present time
    else {
      await this.fetchMessages(this.newestLoaded, false, false);
    }
  }

  /**
   * Fetches the latest messages to jump to bottom
   */
  async fetchLatestMessages() {
    this.setGroups([])
    this.messageIds.clear()
    this.fetchBefore = undefined
    await this.fetchMessages()
  }

  private nextMessageBehavior(
    { lastMessage, message }: {
      lastMessage?: Message,
      message: Message,
    }
  ): MessageDivider | boolean {
    lastMessage ??= this.lastMessage
    if (!lastMessage) return false

    let timestamp = snowflakes.timestamp(message.id)
    let lastTimestamp = snowflakes.timestamp(lastMessage.id)

    const dateStr = new Date(timestamp).toDateString()
    const lastDateStr = new Date(lastTimestamp).toDateString()
    
    // only add a day divider if the messages are from different days
    if (dateStr !== lastDateStr) {
      return { isDivider: true, content: humanizeDate(timestamp) }
    }

    // group messages if they are from the same author and within 15 minutes
    return message.author_id !== lastMessage.author_id
      || message.id - lastMessage.id > SNOWFLAKE_BOUNDARY
  }

  get lastMessage() {
    const group = <Message[]> last(this.groups)
    return last(group)
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
    }
  }

  editMessage(id: bigint, message: Message) {
    const [groupIndex, messageIndex] = this.findCloseMessageIndex(id)
    if (groupIndex < 0) return

    this.setGroups(prev => {
      let groups = [...prev]
      let group = [...<Message[]> groups[groupIndex]]
      group[messageIndex] = message
      groups[groupIndex] = group
      return groups
    })
  }

  private ackNonceWith(nonce: string, message: Message, f: (message: Message) => void) {
    const [groupIndex, messageIndex] = this.nonced.get(nonce)!
    this.nonced.delete(nonce)
    const oldId = (<Message[]> this.groups[groupIndex])[messageIndex].id

    this.setGroups(prev => {
      let groups = [...prev]
      let group = [...<Message[]> groups[groupIndex]]
      Object.assign(group[messageIndex], message)
      f(group[messageIndex])
      groups[groupIndex] = group
      return groups
    })
    this.messageIds.delete(oldId)
    this.messageIds.add(message.id)
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

  private finishGroup(divider?: MessageDivider) {
    this.setGroups(prev => {
      if (divider) prev.push(divider)
      return [...prev, this.currentGroup = []]
    })
  }
}
