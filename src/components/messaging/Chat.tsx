import {
  Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  splitProps,
  Switch,
  untrack,
  type JSX
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Message, MessageReference } from "../../types/message";
import { getApi } from "../../api/Api";
import MessageGrouper, { authorDefault } from "../../api/MessageGrouper";
import {
  displayName,
  extendedColor,
  filterMapIterator,
  flatMapIterator,
  humanizeDate,
  humanizeFullTimestamp,
  humanizeSize,
  humanizeTime,
  humanizeTimestamp,
  isSameDay,
  snowflakes
} from "../../utils";
import TypingKeepAlive from "../../api/TypingKeepAlive";
import { t } from "../../i18n";
import tooltip from "../../directives/tooltip";
import Icon, { IconElement } from "../icons/Icon";
import ArrowDown from "../icons/svg/ArrowDown";
import Clipboard from "../icons/svg/Clipboard";
import Code from "../icons/svg/Code";
import EllipsisVertical from "../icons/svg/EllipsisVertical";
import FaceSmile from "../icons/svg/FaceSmile";
import Hashtag from "../icons/svg/Hashtag";
import Link from "../icons/svg/Link";
import PaperPlaneTop from "../icons/svg/PaperPlaneTop";
import PenToSquare from "../icons/svg/PenToSquare";
import Plus from "../icons/svg/Plus";
import Reply from "../icons/svg/Reply";
import Reference from "../icons/svg/Reference";
import Trash from "../icons/svg/Trash";
import Xmark from "../icons/svg/Xmark";
import { A, useParams } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ReactiveSet } from "@solid-primitives/set";
import type { DmChannel, GuildChannel } from "../../types/channel";
import { RoleFlags, UserFlags } from "../../api/Bitflags";
import MessageContent, { MessageContentProps } from "./MessageContent";
import Fuse from "fuse.js";
import { gemoji } from "gemoji";
import type { User } from "../../types/user";
import useContextMenu from "../../hooks/useContextMenu";
import ContextMenu, { ContextMenuButton, DangerContextMenuButton } from "../ui/ContextMenu";
import { toast } from "solid-toast";
import BookmarkFilled from "../icons/svg/BookmarkFilled";
import { getUnicodeEmojiUrl } from "./Emoji";
import { ModalId, useModal } from "../ui/Modal";
import EmojiPicker from "./EmojiPicker";
import Spinner from "../icons/svg/Spinner";
import At from "../icons/svg/At";
import { stringifyJSON } from "../../api/parseJSON";
import { ExtendedColor } from "../../types/guild";
void tooltip;

const MESSAGE_FETCH_LIMIT = 50;
const MAX_RENDERED_MESSAGES = 200;
const GROUP_WINDOW_MS = 30 * 60 * 1000;
const SCROLL_FETCH_THRESHOLD_PX = 120;
const JUMP_TO_BOTTOM_THRESHOLD_PX = 3200;
const JUMP_HIGHLIGHT_MS = 2400;
const FETCH_COOLDOWN_MS = 1000;
const HISTORY_GLOBAL_COOLDOWN_MS = 800;
const HISTORY_DEDUP_MS = 1500;
const REFERENCE_MISS_TTL_MS = 60_000;

const referenceCache = new Map<bigint, Message>();
const referenceMisses = new Map<bigint, number>();
const historyInFlight = new Map<string, Promise<Message[] | null>>();
const historyRecent = new Map<string, { timestamp: number; data: Message[] }>();
const channelState = new Map<bigint, { reachedOldest: boolean; reachedNewest: boolean }>();

const timestampTooltip = (timestamp: number | Date) => ({
  content: humanizeFullTimestamp(timestamp),
  delay: [1000, null] as [number, null],
  interactive: true,
});

type SkeletalData = {
  headerWidth: string;
  contentLines: string[];
};

function generateSkeletalData(n: number = 10): SkeletalData[] {
  const data: SkeletalData[] = [];
  for (let i = 0; i < n; i++) {
    const headerWidth = `${Math.random() * 25 + 25}%`;
    const contentLines = [];

    const lines = Math.random() * (Math.random() < 0.2 ? 5 : 2);
    for (let j = 0; j < lines; j++) {
      contentLines.push(`${Math.random() * 60 + 20}%`);
    }
    data.push({ headerWidth, contentLines });
  }
  return data;
}

function MessageLoadingSkeleton(props: { count?: number } = {}) {
  const skeletalData = generateSkeletalData(props.count ?? 10);

  return (
    <div class="flex flex-col-reverse gap-y-4">
      <For each={skeletalData}>
        {(data: SkeletalData, i) => (
          <div class="flex flex-col animate-pulse" style={{ "animation-delay": `${i() * 100}ms` }}>
            <div class="flex flex-col relative pl-[62px] py-px hover:bg-bg-1/60 transition-all duration-200">
              <div class="absolute left-4 w-9 h-9 mt-0.5 rounded-full bg-fg/50" />
              <div class="h-5 bg-fg/25 rounded-full" style={{ width: data.headerWidth }} />
              {data.contentLines.map((width) => (
                <div class="h-5 bg-fg/10 rounded-full" style={{ width }} />
              ))}
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

function MessageReferencePreview(props: { reference: MessageReference; grouper?: MessageGrouper }) {
  const api = getApi()!;
  const [refMsg, setRefMsg] = createSignal<Message | null>(null);

  onMount(async () => {
    const cached = referenceCache.get(props.reference.message_id);
    if (cached) {
      setRefMsg(cached);
      return;
    }
    const missedAt = referenceMisses.get(props.reference.message_id);
    if (missedAt && Date.now() - missedAt < REFERENCE_MISS_TTL_MS) {
      return;
    }

    if (props.grouper) {
      for (const group of props.grouper.groups) {
        if (group.isDivider) continue;
        const found = (group as Message[]).find(
          (message) => message.id === props.reference.message_id
        );
        if (found) {
          referenceCache.set(props.reference.message_id, found);
          setRefMsg(found);
          return;
        }
      }
    }

    const response = await api.request<Message>(
      "GET",
      `/channels/${props.reference.channel_id}/messages/${props.reference.message_id}`
    );
    if (response.ok) {
      const message = response.jsonOrThrow();
      referenceCache.set(props.reference.message_id, message);
      setRefMsg(message);
    } else {
      referenceMisses.set(props.reference.message_id, Date.now());
    }
  });

  const author = createMemo(() =>
    refMsg()?.author ?? api.cache!.users.get(refMsg()?.author_id!) ?? authorDefault()
  );
  const avatar = createMemo(() => api.cache!.avatarOf(refMsg()?.author_id!));
  const href = props.reference.guild_id
    ? `/guilds/${props.reference.guild_id}/${props.reference.channel_id}/${props.reference.message_id}`
    : `/dms/${props.reference.channel_id}/${props.reference.message_id}`;

  return (
    <A
      class="pl-8 text-xs text-fg/80 flex items-center text-ellipsis overflow-hidden whitespace-nowrap"
      href={href}
      replace={true}
    >
      <Icon icon={Reference} class="w-4 h-4 mr-1 fill-none stroke-fg/20 mt-2" />
      <Show when={refMsg()} fallback={<span>{t('chat.unknown_message')}</span>}>
        <Show when={avatar()}>
          <img src={avatar()} alt="" class="inline-block w-5 h-5 rounded-full mr-1" />
        </Show>
        <span class="font-semibold text-fg">{displayName(author())}</span>
        {refMsg()!.content ? `: ${refMsg()!.content}` : ""}
      </Show>
    </A>
  );
}

function getWordAt(str: string, pos: number) {
  const left = str.slice(0, pos + 1).search(/\S+$/);
  const right = str.slice(pos).search(/\s/);

  return [right < 0 ? str.slice(left) : str.slice(left, right + pos), left] as const;
}

enum AutocompleteType {
  UserMention,
  ChannelMention,
  Emoji,
}

interface AutocompleteState {
  type: AutocompleteType;
  value: string;
  selected: number;
  data?: any;
}

function trueModulo(n: number, m: number) {
  return ((n % m) + m) % m;
}

function setSelectionRange(
  element: HTMLDivElement,
  selectionStart: number,
  selectionEnd: number = selectionStart
) {
  const range = document.createRange();
  const selection = window.getSelection();

  range.setStart(element.childNodes[0], selectionStart);
  range.setEnd(element.childNodes[0], selectionEnd);
  range.collapse(true);

  selection?.removeAllRanges();
  selection?.addRange(range);
}

type MessageContextMenuProps = {
  message: Message;
  guildId?: bigint;
  editing?: ReactiveSet<bigint>;
  onReply?: (message: Message) => void;
};

function MessageContextMenu({ message, guildId, editing, onReply }: MessageContextMenuProps) {
  const api = getApi()!;
  const { showModal } = useModal();

  const getMessageLink = () => {
    if (guildId) {
      return `https://app.adapt.chat/guilds/${guildId}/${message.channel_id}/${message.id}`;
    }
    return `https://app.adapt.chat/dms/${message.channel_id}/${message.id}`;
  };

  const perms = () => (guildId ? api.cache!.getClientPermissions(guildId, message.channel_id) : null);

  return (
    <ContextMenu>
      <Show when={onReply && (!guildId || perms()?.hasAll("SEND_MESSAGES", "VIEW_MESSAGE_HISTORY"))}>
        <ContextMenuButton icon={Reply} label={t('chat.context_menu.reply')} onClick={() => onReply!(message)} />
      </Show>
      <ContextMenuButton
        icon={BookmarkFilled}
        label={t('chat.context_menu.mark_unread')}
        onClick={() => api.request("PUT", `/channels/${message.channel_id}/ack/${message.id - BigInt(1)}`)}
      />
      <Show when={message.content}>
        <ContextMenuButton
          icon={Clipboard}
          label={t('chat.context_menu.copy_text')}
          onClick={() =>
            toast.promise(navigator.clipboard.writeText(message.content!), {
              loading: t('chat.context_menu.copy_text_loading'),
              success: t('chat.context_menu.copy_text_success'),
              error: t('chat.context_menu.copy_text_error'),
            })
          }
        />
      </Show>
      <ContextMenuButton
        icon={Code}
        label={t('chat.context_menu.copy_message_id')}
        onClick={() => navigator.clipboard.writeText(message.id.toString())}
      />
      <ContextMenuButton
        icon={Link}
        label={t('chat.context_menu.copy_message_link')}
        onClick={() =>
          toast.promise(navigator.clipboard.writeText(getMessageLink()), {
            loading: t('chat.context_menu.copy_link_loading'),
            success: t('chat.context_menu.copy_link_success'),
            error: t('chat.context_menu.copy_link_error'),
          })
        }
      />
      <Show when={editing != null && message.author_id == api.cache!.clientId}>
        <ContextMenuButton
          icon={PenToSquare}
          label={t('chat.context_menu.edit_message')}
          onClick={() => editing!.add(message.id)}
        />
      </Show>
      <Show when={message.author_id == api.cache!.clientId || (guildId && perms()?.has("MANAGE_MESSAGES"))}>
        <DangerContextMenuButton
          icon={Trash}
          label={t('chat.context_menu.delete_message')}
          onClick={async (event) => {
            if (!event.shiftKey) return showModal(ModalId.DeleteMessage, message);

            const resp = await api.deleteMessage(message.channel_id, message.id);
            if (!resp.ok) {
              toast.error(`Failed to delete message: ${resp.errorJsonOrThrow().message}`);
            }
          }}
        />
      </Show>
    </ContextMenu>
  );
}

interface UploadedAttachment {
  filename: string;
  alt?: string;
  file: File;
  type: string;
  preview?: string;
}

function highlightClasses(jump: boolean, mention: boolean, noHoverEffects?: boolean): string {
  if (jump) return "bg-secondary/10 hover:bg-secondary/20 border-l-2 border-l-secondary";
  if (mention) return "bg-accent/10 hover:bg-accent/20 border-l-2 border-l-accent";
  if (noHoverEffects) return "border-l-2 border-l-transparent";
  return "hover:bg-bg-1/60 border-l-2 border-l-transparent";
}

function QuickActionButton(
  { icon, tooltip: tt, ...props }: { icon: IconElement; tooltip: string } & JSX.ButtonHTMLAttributes<HTMLButtonElement>
) {
  return (
    <button
      class="p-2 aspect-square rounded-full hover:bg-fg/10 transition group/action"
      use:tooltip={tt}
      {...props}
    >
      <Icon icon={icon} class="fill-fg/70 w-4 h-4 group-hover/action:fill-accent/100 transition" />
    </button>
  );
}

type QuickActionsProps = {
  message: Message;
  offset?: number;
  guildId?: bigint;
  editing?: ReactiveSet<bigint>;
  onReply: (message: Message) => void;
};

function QuickActions(props: QuickActionsProps) {
  const contextMenu = useContextMenu();
  const permissions = createMemo(() =>
    props.guildId ? getApi()?.cache?.getClientPermissions(props.guildId, props.message.channel_id) : null
  );

  return (
    <div
      class="absolute backdrop-blur right-3 rounded-full bg-bg-0/80 p-0.5 z-[100] hidden group-hover:flex"
      style={{ top: `-${(props.offset ?? 4) * 4}px` }}
    >
      <Show when={!permissions() || permissions()!.has("ADD_REACTIONS")}>
        <QuickActionButton icon={FaceSmile} tooltip={t('chat.add_reaction')} />
      </Show>
      <Show when={!permissions() || permissions()!.hasAll("SEND_MESSAGES", "VIEW_MESSAGE_HISTORY")}>
        <QuickActionButton icon={Reply} tooltip={t('chat.reply')} onClick={() => props.onReply(props.message)} />
      </Show>
      <QuickActionButton
        icon={EllipsisVertical}
        tooltip={t('generic.more')}
        onClick={contextMenu?.getHandler(
          <MessageContextMenu
            message={props.message}
            guildId={props.guildId}
            onReply={props.onReply}
            editing={props.editing}
          />
        )}
      />
    </div>
  );
}

export type MessageHeaderProps = {
  mentionHighlight?: boolean,
  jumpHighlight?: boolean,
  onContextMenu?: (e: MouseEvent) => any,
  authorAvatar?: string,
  authorColor?: ExtendedColor | null,
  authorName: string,
  badge?: string,
  timestamp: number | Date,
  class?: string,
  classList?: Record<string, boolean>,
  noHoverEffects?: boolean,
  quickActions?: ReturnType<typeof QuickActions>,
  referencesProvider?: {
    references: MessageReference[],
    grouper: MessageGrouper,
  },
}

export function MessageHeader(props: ParentProps<MessageHeaderProps>) {
  return (
    <div
      class="flex flex-col py-px transition-all duration-200 rounded-r-lg group"
      classList={{ 
        [highlightClasses(!!props.jumpHighlight, !!props.mentionHighlight, !!props.noHoverEffects)]: true,
        [props.class ?? ""]: true, 
        ...(props.classList ?? {}), 
    }}
      onContextMenu={props.onContextMenu}
    >
      <Show when={props.referencesProvider}>
        <For each={props.referencesProvider!.references}>
          {(ref) => (
            <MessageReferencePreview
              reference={ref}
              grouper={props.referencesProvider!.grouper}
            />
          )}
        </For>
      </Show>
      <div class="flex flex-col relative pl-[60px]">
        {props.quickActions}
        <img class="absolute left-3.5 w-9 h-9 mt-0.5 rounded-full" src={props.authorAvatar} alt="" />
        <div class="inline text-sm">
          <span class="font-medium" style={extendedColor.fg(props.authorColor)}>
            {props.authorName}
            <Show when={props.badge}>
              <span class="text-xs ml-1.5 rounded px-1 py-[1px] bg-accent text-fg">{props.badge}</span>
            </Show>
          </span>
          <span
            class="timestamp text-fg/50 text-xs ml-2"
            use:tooltip={timestampTooltip(props.timestamp)}
          >
            {humanizeTimestamp(props.timestamp)}
          </span>
        </div>
        {props.children}
      </div>
    </div>
  );
}

type MessageRowProps = {
  guildId?: bigint;
  message: Message;
  grouper?: MessageGrouper;
  editing?: ReactiveSet<bigint>;
  largePadding?: boolean;
  noHoverEffects?: boolean;
  mentionHighlight?: boolean;
  jumpHighlight?: boolean;
  onReply?: (message: Message) => void;
};

export function MessagePrimary(props: MessageRowProps) {
  const api = getApi()!;
  const contextMenu = useContextMenu();
  const message = () => props.message;

  // if no guild id is provided, try resolving one
  const guildId = createMemo(() =>
    props.guildId ?? (api.cache!.channels.get(message().channel_id) as GuildChannel | undefined)?.guild_id
  );

  const author = createMemo(() =>
    message().author ?? api.cache!.users.get(message().author_id!) ?? authorDefault()
  );
  const authorColor = createMemo(() =>
    guildId() && message().author_id ? api.cache!.getMemberColor(guildId()!, message().author_id!) : undefined
  );

  return (
    <MessageHeader 
      mentionHighlight={props.mentionHighlight}
      jumpHighlight={props.jumpHighlight}
      onContextMenu={contextMenu?.getHandler(
        <MessageContextMenu
          message={message()}
          guildId={props.guildId}
          editing={props.editing}
          onReply={props.onReply}
        />
      )}
      authorAvatar={api.cache!.avatarOf(message().author_id!)}
      authorColor={authorColor()}
      authorName={displayName(author())}
      badge={UserFlags.fromValue(author().flags).has("BOT") ? t('chat.bot_badge') : undefined}
      timestamp={snowflakes.timestamp(message().id)}
      quickActions={
        props.onReply && <QuickActions
          message={message()}
          guildId={props.guildId}
          editing={props.editing}
          onReply={props.onReply}
          offset={message().references?.length ? message().references!.length * 6 + 4 : 4}
        />
      }
      referencesProvider={props.grouper && {
        references: message().references,
        grouper: props.grouper,
      }}
      noHoverEffects={props.noHoverEffects}
    >
      <MessageContent
        message={props.message} 
        grouper={props.grouper} 
        editing={props.editing} 
        largePadding={props.largePadding} 
      />
    </MessageHeader>
  )
}

function MessageSecondary(props: MessageRowProps) {
  const contextMenu = useContextMenu();
  const message = () => props.message;

  return (
    <div
      class="relative group flex items-center py-px transition-all duration-200 rounded-r-lg"
      classList={{ [highlightClasses(!!props.jumpHighlight, !!props.mentionHighlight, !!props.noHoverEffects)]: true }}
      onContextMenu={contextMenu?.getHandler(
        <MessageContextMenu
          message={message()}
          guildId={props.guildId}
          editing={props.editing}
          onReply={props.onReply}
        />
      )}
    >
      {props.onReply && <QuickActions
        message={message()}
        guildId={props.guildId}
        editing={props.editing}
        onReply={props.onReply}
        offset={9}
      />}
      <span
        class="invisible text-center group-hover:visible text-[0.65rem] text-fg/40 w-[60px]"
        use:tooltip={timestampTooltip(snowflakes.timestamp(message().id))}
      >
        {humanizeTime(snowflakes.timestamp(message().id))}
      </span>
      <MessageContent
        message={message()}
        grouper={props.grouper}
        editing={props.editing}
        largePadding
      />
    </div>
  );
}

type RenderBlock =
  | { type: "header"; id: "header" }
  | { type: "divider"; id: string; content: string }
  | { type: "group"; id: string; messageIds: bigint[] };

type MessageGroupViewProps = {
  block: RenderBlock;
  guildId?: bigint;
  grouper: MessageGrouper;
  editing: ReactiveSet<bigint>;
  title: string;
  startMessage: JSX.Element;
  messageById: (id: bigint) => Message | undefined;
  isMentioned: (message: Message) => boolean;
  isJumpHighlight: (messageId: bigint) => boolean;
  onReply: (message: Message) => void;
};

function MessageGroupView(props: MessageGroupViewProps) {
  if (props.block.type === "header") {
    return (
      <div class="pl-4 pt-8">
        <h1 class="font-title font-bold text-xl">{props.title}</h1>
        <p class="text-fg/60 text-sm">{props.startMessage}</p>
      </div>
    );
  }

  if (props.block.type === "divider") {
    return (
      <div class="divider text-fg/50 mx-4 h-0 text-sm">{props.block.content}</div>
    );
  }

  return (
    <div class="flex flex-col">
      <For each={props.block.messageIds}>
        {(messageId, i) => {
          const message = () => props.messageById(messageId);
          return (
            <Show when={message()}>
              {(msg) => (
                <Show
                  when={i() === 0}
                  fallback={
                    <MessageSecondary
                      message={msg()}
                      guildId={props.guildId}
                      grouper={props.grouper}
                      editing={props.editing}
                      mentionHighlight={props.isMentioned(msg())}
                      jumpHighlight={props.isJumpHighlight(msg().id)}
                      onReply={props.onReply}
                    />
                  }
                >
                  <MessagePrimary
                    message={msg()}
                    guildId={props.guildId}
                    grouper={props.grouper}
                    editing={props.editing}
                    mentionHighlight={props.isMentioned(msg())}
                    jumpHighlight={props.isJumpHighlight(msg().id)}
                    onReply={props.onReply}
                  />
                </Show>
              )}
            </Show>
          );
        }}
      </For>
    </div>
  );
}

function findIndexOrNext(messages: Message[], id: bigint): number {
  let lo = 0;
  let hi = messages.length - 1;
  let res = messages.length;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].id >= id) {
      res = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return res;
}

function findIndexOrPrev(messages: Message[], id: bigint): number {
  let lo = 0;
  let hi = messages.length - 1;
  let res = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].id <= id) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

function findExactIndex(messages: Message[], id: bigint): number {
  let lo = 0;
  let hi = messages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].id === id) return mid;
    if (messages[mid].id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function resolveWindowIndices(
  messages: Message[],
  startId: bigint | null,
  endId: bigint | null
): { start: number; end: number } {
  if (messages.length === 0) return { start: 0, end: 0 };
  const start = startId == null ? 0 : Math.min(findIndexOrNext(messages, startId), messages.length);
  const end = endId == null ? messages.length : Math.min(findIndexOrPrev(messages, endId) + 1, messages.length);
  return { start, end: Math.max(start, end) };
}

export default function Chat(props: {
  channelId: bigint;
  guildId?: bigint;
  title: string;
  startMessage: JSX.Element;
}) {
  const api = getApi()!;
  const params = useParams();
  const messageId = createMemo(() => (params.messageId ? BigInt(params.messageId) : null));

  const [messageInputFocused, setMessageInputFocused] = createSignal(false);
  const [messageInputFocusTimeout, setMessageInputFocusTimeout] = createSignal<number | null>(null);
  const [autocompleteState, setAutocompleteState] = createSignal<AutocompleteState | null>(null);
  const [uploadedAttachments, setUploadedAttachments] = createSignal<UploadedAttachment[]>([]);
  const [replyingTo, setReplyingTo] = createSignal<{ message: Message; mentionAuthor: boolean }[]>([]);
  const [sendable, setSendable] = createSignal(false);
  const [emojiPickerVisible, setEmojiPickerVisible] = createSignal(false);
  let emojiPickerRef: HTMLDivElement | undefined;
  let emojiToggleRef: HTMLButtonElement | undefined;
  let messageInputRef: HTMLDivElement | undefined;

  const [loading, setLoading] = createSignal(true);
  const [windowStartId, setWindowStartId] = createSignal<bigint | null>(null);
  const [windowEndId, setWindowEndId] = createSignal<bigint | null>(null);
  const [reachedOldest, setReachedOldest] = createSignal(false);
  const [reachedNewest, setReachedNewest] = createSignal(false);
  const [jumpHighlightId, setJumpHighlightId] = createSignal<bigint | null>(null);
  const [lastJumpedId, setLastJumpedId] = createSignal<bigint | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = createSignal(false);
  const [lastAckedId, setLastAckedId] = createSignal<bigint | null>(null);
  const [fetchingOlder, setFetchingOlder] = createSignal(false);
  const [fetchingNewer, setFetchingNewer] = createSignal(false);
  const [fetchingAround, setFetchingAround] = createSignal(false);
  const [fetchingLatest, setFetchingLatest] = createSignal(false);
  const [scrollAnchor, setScrollAnchor] = createSignal<"oldest" | "newest">("newest");
  const isFetching = () =>
    fetchingOlder() || fetchingNewer() || fetchingAround() || fetchingLatest();

  let jumpHighlightTimeout: number | undefined;
  let scrollRaf: number | undefined;
  let lastFetchStartedAt = 0;
  let lastHistoryRequestAt = 0;
  let lastAtTop = false;
  let lastAtBottom = false;
  let previousChannelId: bigint | null = null;

  let messageAreaRef: HTMLDivElement | undefined;
  const channelMessages = createMemo(() => api.cache!.useChannelMessages(props.channelId));
  const grouper = createMemo(() => channelMessages().grouper);
  const messages = createMemo(() => grouper().messages);

  const updateSendable = () =>
    setSendable(!!messageInputRef?.innerText?.trim() || uploadedAttachments().length > 0);

  const addReply = (message: Message) => {
    setReplyingTo((prev) =>
      prev.some(({ message: m }) => m.id === message.id)
        ? prev
        : [...prev, { message, mentionAuthor: false }]
    );
    messageInputRef?.focus();
  };
  const removeReply = (id: bigint) =>
    setReplyingTo((prev) => prev.filter(({ message: m }) => m.id !== id));
  const setMentionAuthor = (message: Message, mentionAuthor: boolean) => {
    setReplyingTo((prev) =>
      prev.map(({ message: m, mentionAuthor: ma }) =>
        m.id === message.id ? { message: m, mentionAuthor } : { message: m, mentionAuthor: ma }
      )
    );
  };

  const mobile = /Android|webOS|iPhone|iP[ao]d|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const typing = createMemo(() => api.cache!.useTyping(props.channelId));
  const typingKeepAlive = createMemo(() => new TypingKeepAlive(api, props.channelId));
  createEffect(() => {
    const keeper = typingKeepAlive();
    onCleanup(async () => {
      await keeper.stop();
    });
  });

  const editing = new ReactiveSet<bigint>();

  onCleanup(() => {
    if (jumpHighlightTimeout) window.clearTimeout(jumpHighlightTimeout);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
  });

  const isNearBottom = () => {
    if (!messageAreaRef) return false;
    const distance =
      messageAreaRef.scrollHeight - messageAreaRef.clientHeight - messageAreaRef.scrollTop;
    return distance < SCROLL_FETCH_THRESHOLD_PX;
  };

  const setWindowByIndices = (start: number, end: number) => {
    const list = messages();
    if (list.length === 0) {
      setWindowStartId(null);
      setWindowEndId(null);
      return;
    }
    const clampedStart = Math.max(0, Math.min(start, list.length - 1));
    const clampedEnd = Math.max(clampedStart + 1, Math.min(end, list.length));
    setWindowStartId(list[clampedStart].id);
    setWindowEndId(list[clampedEnd - 1].id);
    queueMicrotask(() => updateScrollIndicators());
  };

  const setWindowToLatest = () => {
    const list = messages();
    const end = list.length;
    const start = Math.max(0, end - MAX_RENDERED_MESSAGES);
    if (list.length > 0) setWindowByIndices(start, end);
  };

  const setWindowAround = (targetId: bigint) => {
    const list = messages();
    const index = findExactIndex(list, targetId);
    if (index === -1) return false;
    const half = Math.floor(MAX_RENDERED_MESSAGES / 2);
    let start = Math.max(0, index - half);
    let end = Math.min(list.length, start + MAX_RENDERED_MESSAGES);
    if (end - start < MAX_RENDERED_MESSAGES && start > 0) {
      start = Math.max(0, end - MAX_RENDERED_MESSAGES);
    }
    setWindowByIndices(start, end);
    return true;
  };

  const preserveScrollPosition = (update: () => void) => {
    if (!messageAreaRef) {
      update();
      return;
    }
    const previousScrollHeight = messageAreaRef.scrollHeight;
    const previousScrollTop = messageAreaRef.scrollTop;
    update();
    queueMicrotask(() => {
      if (!messageAreaRef) return;
      const nextScrollHeight = messageAreaRef.scrollHeight;
      messageAreaRef.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
    });
  };

  const fetchHistory = async (
    channelId: bigint,
    params: Record<string, bigint | number | boolean>
  ) => {
    const now = Date.now();
    if (now - lastHistoryRequestAt < HISTORY_GLOBAL_COOLDOWN_MS) return null;

    const key = [
      channelId.toString(),
      Object.keys(params)
      .sort()
      .map((k) => `${k}:${String(params[k])}`)
      .join("|"),
    ].join("|");
    const cached = historyRecent.get(key);
    if (cached && now - cached.timestamp < HISTORY_DEDUP_MS) return cached.data;

    const inFlight = historyInFlight.get(key);
    if (inFlight) return inFlight;

    lastHistoryRequestAt = now;
    const task = (async () => {
      const response = await api.request<Message[]>(
        "GET",
        `/channels/${channelId}/messages`,
        {
          params: {
            limit: MESSAGE_FETCH_LIMIT,
            ...params,
          },
        }
      );
      if (!response.ok) return null;
      const data = response.jsonOrThrow().slice().reverse();
      historyRecent.set(key, { timestamp: Date.now(), data });
      return data;
    })();

    historyInFlight.set(key, task);
    try {
      return await task;
    } finally {
      historyInFlight.delete(key);
    }
  };

  const canStartFetch = (force: boolean = false) => {
    const now = Date.now();
    if (!force && now - lastFetchStartedAt < FETCH_COOLDOWN_MS) return false;
    lastFetchStartedAt = now;
    return true;
  };

  const fetchLatest = async () => {
    if (fetchingLatest() || isFetching()) return;
    if (!canStartFetch(true)) return;
    const channelId = props.channelId;
    setFetchingLatest(true);
    const list = messages();
    const prevLength = list.length;
    const result = await fetchHistory(channelId, {});
    if (props.channelId !== channelId) {
      setFetchingLatest(false);
      return;
    }
    if (!result) {
      setFetchingLatest(false);
      return;
    }
    if (result.length === 0) {
      setReachedOldest(true);
      setReachedNewest(true);
      setLoading(false);
      setFetchingLatest(false);
      return;
    }

    grouper().insertMessages(result);
    const nextLength = messages().length;
    const added = nextLength - prevLength;

    if (added > 0) setWindowToLatest();
    setReachedNewest(true);
    if (result.length < MESSAGE_FETCH_LIMIT) setReachedOldest(true);
    setLoading(false);
    setFetchingLatest(false);
  };

  const fetchOlder = async () => {
    if (fetchingOlder() || reachedOldest() || isFetching()) return;
    if (!canStartFetch()) return;
    const channelId = props.channelId;
    const list = messages();
    if (list.length === 0) {
      await fetchLatest();
      return;
    }

    const oldest = list[0].id;
    setFetchingOlder(true);
    const result = await fetchHistory(channelId, { before: oldest });
    if (props.channelId !== channelId) {
      setFetchingOlder(false);
      return;
    }
    if (!result) {
      setFetchingOlder(false);
      return;
    }
    const prevLength = list.length;
    grouper().insertMessages(result);
    const nextList = messages();
    const added = nextList.length - prevLength;

    if (result.length < MESSAGE_FETCH_LIMIT) setReachedOldest(true);

    if (added > 0) {
      const boundaryRange = resolveWindowIndices(nextList, windowStartId(), windowEndId());
      const start = Math.max(0, boundaryRange.start - added);
      const end = boundaryRange.end;
      preserveScrollPosition(() => {
        const targetEnd = Math.min(start + MAX_RENDERED_MESSAGES, nextList.length, end);
        setWindowByIndices(start, targetEnd);
      });
    }

    setFetchingOlder(false);
  };

  const fetchNewer = async () => {
    if (fetchingNewer() || reachedNewest() || isFetching()) return;
    if (!canStartFetch()) return;
    const channelId = props.channelId;
    const list = messages();
    if (list.length === 0) {
      await fetchLatest();
      return;
    }

    const newest = list[list.length - 1].id;
    setFetchingNewer(true);
    const result = await fetchHistory(channelId, { after: newest });
    if (props.channelId !== channelId) {
      setFetchingNewer(false);
      return;
    }
    if (!result) {
      setFetchingNewer(false);
      return;
    }
    const prevLength = list.length;
    grouper().insertMessages(result);
    const nextList = messages();
    const added = nextList.length - prevLength;

    if (result.length < MESSAGE_FETCH_LIMIT) setReachedNewest(true);

    if (added > 0) {
      const boundaryRange = resolveWindowIndices(nextList, windowStartId(), windowEndId());
      const end = Math.min(boundaryRange.end + added, nextList.length);
      let start = boundaryRange.start;
      if (end - start > MAX_RENDERED_MESSAGES) start = end - MAX_RENDERED_MESSAGES;
      if (isNearBottom()) {
        setWindowByIndices(start, end);
      } else {
        preserveScrollPosition(() => {
          setWindowByIndices(start, end);
        });
      }
    }

    setFetchingNewer(false);
  };

  const fetchAround = async (targetId: bigint) => {
    if (fetchingAround()) return;
    if (!canStartFetch(true)) return;
    const channelId = props.channelId;
    setFetchingAround(true);
    const result = await fetchHistory(channelId, { around: targetId });
    if (props.channelId !== channelId) {
      setFetchingAround(false);
      return;
    }
    if (!result) {
      setFetchingAround(false);
      return;
    }
    grouper().insertMessages(result);

    const targetIndex = result.findIndex((message) => message.id === targetId);
    if (targetIndex === 0 && result.length > 0) setReachedOldest(true);
    if (targetIndex === result.length - 1 && result.length > 0) setReachedNewest(true);

    setFetchingAround(false);
  };

  const jumpHighlight = (targetId: bigint) => {
    if (jumpHighlightTimeout) window.clearTimeout(jumpHighlightTimeout);
    setJumpHighlightId(targetId);
    jumpHighlightTimeout = window.setTimeout(() => {
      setJumpHighlightId(null);
    }, JUMP_HIGHLIGHT_MS);
  };

  const findBlockIndex = (blocks: RenderBlock[], targetId: bigint) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "group") continue;
      if (block.messageIds.includes(targetId)) return i;
    }
    return -1;
  };

  const scrollToMessage = async (targetId: bigint, blocks: RenderBlock[]) => {
    if (!messageAreaRef) return;
    const blockIndex = findBlockIndex(blocks, targetId);
    if (blockIndex >= 0) {
      rowVirtualizer.scrollToIndex(blockIndex, { align: "center" });
      await new Promise(requestAnimationFrame);
    }
    const target = messageAreaRef.querySelector(`[data-message-id="${targetId}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleJump = async (targetId: bigint) => {
    if (isFetching()) {
      while (isFetching()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const list = messages();
    if (findExactIndex(list, targetId) === -1) await fetchAround(targetId);
    if (!setWindowAround(targetId)) return;

    await new Promise(requestAnimationFrame);
    await scrollToMessage(targetId, renderBlocks());
    jumpHighlight(targetId);
    setLastJumpedId(targetId);
  };

  const maybeShiftOlderWindow = () => {
    const list = messages();
    const range = resolveWindowIndices(list, windowStartId(), windowEndId());
    if (range.start <= 0) return false;

    const shift = Math.min(MESSAGE_FETCH_LIMIT, range.start);
    const start = range.start - shift;
    const end = range.end;
    preserveScrollPosition(() => {
      const targetEnd = Math.min(start + MAX_RENDERED_MESSAGES, list.length, end);
      setWindowByIndices(start, targetEnd);
    });
    return true;
  };

  const maybeShiftNewerWindow = () => {
    const list = messages();
    const range = resolveWindowIndices(list, windowStartId(), windowEndId());
    if (range.end >= list.length) return false;

    const shift = Math.min(MESSAGE_FETCH_LIMIT, list.length - range.end);
    let end = range.end + shift;
    let start = range.start;
    if (end - start > MAX_RENDERED_MESSAGES) start = end - MAX_RENDERED_MESSAGES;
    if (isNearBottom()) {
      setWindowByIndices(start, end);
    } else {
      preserveScrollPosition(() => {
        setWindowByIndices(start, end);
      });
    }
    return true;
  };

  const maybeLoadOlder = async () => {
    if (maybeShiftOlderWindow()) return;
    if (isFetching()) return;
    if (reachedOldest() || fetchingOlder()) return;
    await fetchOlder();
  };

  const maybeLoadNewer = async () => {
    if (maybeShiftNewerWindow()) return;
    if (isFetching()) return;
    if (reachedNewest() || fetchingNewer()) return;
    await fetchNewer();
  };

  const updateScrollIndicators = (distanceFromBottom?: number) => {
    if (!messageAreaRef) return;
    const nodes = messageAreaRef.querySelectorAll("[data-message-id]");
    if (nodes.length === 0) {
      setShowScrollToBottom(false);
      return;
    }

    const list = messages();
    const rendered = renderedMessages();
    const atNewest =
      reachedNewest() &&
      list.length > 0 &&
      rendered.length > 0 &&
      rendered[rendered.length - 1].id === list[list.length - 1].id;

    distanceFromBottom ??=
      messageAreaRef.scrollHeight - messageAreaRef.clientHeight - messageAreaRef.scrollTop;
    setShowScrollToBottom(!atNewest || distanceFromBottom > JUMP_TO_BOTTOM_THRESHOLD_PX);
  };

  const [lastObservedNewest, setLastObservedNewest] = createSignal<bigint | null>(null);
  createEffect(() => {
    const list = messages();
    if (list.length === 0) {
      setLastObservedNewest(null);
      return;
    }
    const newestId = list[list.length - 1].id;
    const previousNewest = lastObservedNewest();
    setLastObservedNewest(newestId);

    if (!previousNewest || newestId === previousNewest) return;
    if (scrollAnchor() !== "newest") return;
    if (windowEndId() !== previousNewest) return;

    setWindowToLatest();
    if (isNearBottom()) {
      queueMicrotask(() => {
        messageAreaRef?.scrollTo({ top: messageAreaRef.scrollHeight });
      });
    }
  });

  const ack = async () => {
    const last = api.cache?.lastMessages.get(props.channelId);
    if (!last) return;

    if (lastAckedId() === last.id) return;
    if ("author_id" in last && last.author_id === api.cache?.clientId) return;

    setLastAckedId(last.id);
    await api.request("PUT", `/channels/${props.channelId}/ack/${last.id}`);
  };

  const focusListener = (event: KeyboardEvent) => {
    const charCode = event.key.charCodeAt(0);
    if (
      document.activeElement == document.body &&
      ((event.key.length == 1 &&
        charCode >= 32 &&
        charCode <= 126 &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey) ||
        ((event.ctrlKey || event.metaKey) && event.key == "v"))
    ) {
      messageInputRef?.focus();
    }
  };

  const hideEmojiPicker = (event: MouseEvent) => {
    if (
      emojiPickerVisible() &&
      emojiPickerRef &&
      !emojiPickerRef.contains(event.target as Node) &&
      !emojiToggleRef?.contains(event.target as Node)
    ) {
      setEmojiPickerVisible(false);
    }
  };

  onMount(() => {
    document.addEventListener("keydown", focusListener);
    document.addEventListener("click", hideEmojiPicker);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", focusListener);
    document.removeEventListener("click", hideEmojiPicker);
  });

  const createMessage = async () => {
    if (!sendable() || !messageInputRef) return;
    const content = messageInputRef.innerText.trim();
    const attachments = uploadedAttachments();
    const references = replyingTo();

    setUploadedAttachments([]);
    setReplyingTo([]);
    setSendable(false);
    messageInputRef.focus();
    document.execCommand("selectAll", false);
    document.execCommand("insertHTML", false, "");

    const refs = references.map(({ message: ref, mentionAuthor }) => ({
      channel_id: ref.channel_id,
      guild_id: (api.cache?.channels.get(ref.channel_id) as GuildChannel | undefined)?.guild_id ?? null,
      mention_author: mentionAuthor,
      message_id: ref.id,
    }));

    const mockMessage = {
      id: snowflakes.fromTimestamp(Date.now()),
      type: "default",
      content,
      author_id: api.cache!.clientUser!.id,
      attachments: attachments.map((attachment) => ({
        _imageOverride: attachment.preview,
        filename: attachment.filename,
        alt: attachment.alt,
        size: attachment.file.size,
      })),
      _nonceState: "pending",
      ...grouper().nonceDefault,
      references: refs,
    } as Message;

    const nonce = mockMessage.id.toString();
    const idx = grouper().pushMessage(mockMessage);
    grouper().nonced.set(nonce, idx);
    if (loading()) setLoading(false);
    if (scrollAnchor() === "newest" || windowStartId() == null || windowEndId() == null) {
      setWindowToLatest();
    }
    messageAreaRef?.scrollTo(0, messageAreaRef.scrollHeight);

    try {
      const json = { content, nonce, references: refs };

      let options;
      if (attachments.length > 0) {
        const formData = new FormData();
        formData.append("json", stringifyJSON(json));
        for (const [i, attachment] of Object.entries(attachments)) {
          formData.append("file" + i, attachment.file, attachment.filename);
        }
        options = { multipart: formData };
      } else {
        options = { json };
      }

      const response = await api.request("POST", `/channels/${props.channelId}/messages`, options);
      void typingKeepAlive().stop();
      if (!response.ok) {
        grouper().ackNonceError(nonce, mockMessage, response.errorJsonOrThrow().message);
      }
    } catch (error: any) {
      grouper().ackNonceError(nonce, mockMessage, error);
      throw error;
    }
  };

  const MAPPING = [
    ["@", AutocompleteType.UserMention],
    ["#", AutocompleteType.ChannelMention],
    [":", AutocompleteType.Emoji],
  ] as const;
  let caretPosition = 0;
  const cacheCaretPosition = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && messageInputRef && messageInputRef.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      const preRange = range.cloneRange();
      preRange.selectNodeContents(messageInputRef);
      preRange.setEnd(range.endContainer, range.endOffset);
      caretPosition = preRange.toString().length;
    }
  };
  let autocompleteTimeout: number | undefined;
  const updateAutocompleteState = () => {
    if (!messageInputRef || caretPosition <= 0) {
      setAutocompleteState(null);
      return;
    }
    const text = messageInputRef.innerText ?? "";
    const [currentWord, index] = getWordAt(text, caretPosition - 1);
    for (const [char, type] of MAPPING) {
      if (currentWord.startsWith(char)) {
        setAutocompleteState({
          type,
          value: currentWord.slice(1),
          selected: 0,
          data: { index },
        });
        return;
      }
    }
    setAutocompleteState(null);
  };
  const scheduleAutocompleteUpdate = () => {
    clearTimeout(autocompleteTimeout);
    autocompleteTimeout = window.setTimeout(updateAutocompleteState, 50);
  };
  const handleCaretUpdate = () => {
    cacheCaretPosition();
    scheduleAutocompleteUpdate();
  };

  const members = createMemo(() => {
    const cache = api.cache;
    if (!cache) return [];

    const users =
      (props.guildId
        ? cache.memberReactor.get(props.guildId)?.map((userId) => cache.users.get(userId))
        : (cache.channels.get(props.channelId) as DmChannel | null)?.recipient_ids.map((userId) =>
            cache.users.get(userId)
          )) ?? [];
    return users.filter((user): user is User => !!user);
  });
  const fuseMemberIndex = createMemo(
    () =>
      new Fuse(members(), {
        keys: ["username", "display_name"],
      })
  );

  const permissions = createMemo(() =>
    props.guildId ? api.cache!.getClientPermissions(props.guildId, props.channelId) : null
  );
  const canSendMessages = createMemo(() => !permissions() || permissions()!.has("SEND_MESSAGES"));

  const recipientId = createMemo(() => {
    if (props.guildId) return null;
    const ids = (api.cache?.channels.get(props.channelId) as DmChannel | null)
      ?.recipient_ids as any;
    return ids?.[0] == api.cache?.clientId ? ids?.[1] : ids?.[0];
  });
  const channels = createMemo(() => {
    const cache = api.cache;
    if (!cache) return [];

    if (props.guildId) {
      return [...(cache.guilds.get(props.guildId)?.channels?.values() ?? [])];
    }

    const mutualGuildIds = cache.userGuilds.get(recipientId()!) ?? [];
    return [
      ...flatMapIterator(mutualGuildIds, (guildId) => {
        const guild = cache.guilds.get(guildId);
        return (
          guild?.channels?.map(
            (channel) => ({ ...channel, key: `${channel.name}:${guild.name}` }) as GuildChannel & {
              key: string;
            }
          ) ?? []
        );
      }),
    ];
  });
  const fuseChannelIndex = createMemo(
    () =>
      new Fuse(channels(), {
        keys: ["key", "name"],
      })
  );

  const externalAllowedFrom = createMemo(() => {
    if (!props.guildId || permissions()?.has("USE_EXTERNAL_EMOJIS")) return api.cache?.guildList ?? [];
    return [props.guildId];
  });
  const emojis = createMemo(() => {
    const unicode = gemoji.flatMap(({ names, emoji, category }) =>
      names.map((name) => ({
        name,
        emoji,
        url: getUnicodeEmojiUrl(emoji),
        category,
      }))
    );
    const allowed = externalAllowedFrom();
    const custom = filterMapIterator(api.cache!.customEmojis.values(), (emoji) =>
      allowed.includes(emoji.guild_id)
        ? {
            name: emoji.name,
            emoji: `:${emoji.id}:`,
            url: `https://convey.adapt.chat/emojis/${emoji.id}`,
            category: api.cache!.guilds.get(emoji.guild_id)?.name ?? "Custom",
            data: emoji,
          }
        : null
    );
    return [...unicode, ...custom];
  });
  const fuseEmojiIndex = createMemo(() => new Fuse(emojis(), { keys: ["name"] }));

  const setAutocompleteSelection = (index: number) => {
    setAutocompleteState((prev) => ({
      ...prev!,
      selected: trueModulo(index, autocompleteResult()?.length || 1),
    }));
  };
  const fuse = function <T>(value: string, index: Accessor<Fuse<T>>, fallback: Accessor<T[]>) {
    return value ? index()?.search(value).slice(0, 5).map((result) => result.item) : fallback().slice(0, 5);
  };
  const autocompleteResult = createMemo(() => {
    const state = autocompleteState();
    if (!state) return;

    const { type, value } = state;
    switch (type) {
      case AutocompleteType.UserMention:
        return fuse(value, fuseMemberIndex, members);
      case AutocompleteType.ChannelMention:
        return fuse(value, fuseChannelIndex, channels);
      case AutocompleteType.Emoji:
        return fuse(value, fuseEmojiIndex, () => []);
    }
  });
  const executeAutocomplete = (index?: number) => {
    const result = autocompleteResult();
    if (!result?.length || !messageInputRef) {
      setAutocompleteState(null);
      return;
    }

    const { type, value, selected } = autocompleteState()!;
    const replace = (repl: string) => {
      const { index: wordIndex } = autocompleteState()!.data!;

      const text = messageInputRef.innerText ?? "";
      const before = text.slice(0, wordIndex) + repl;
      const after = text.slice(wordIndex + value.length + 1);
      messageInputRef.innerText = before + after;

      messageInputRef.focus();
      setSelectionRange(messageInputRef, before.length);
    };

    switch (type) {
      case AutocompleteType.UserMention:
      case AutocompleteType.ChannelMention: {
        const target = result[index ?? selected] as User | GuildChannel;
        const symbol = MAPPING.find(([_, ty]) => type === ty)![0];
        replace(`<${symbol}${target.id}>`);
        break;
      }
      case AutocompleteType.Emoji:
        replace((result[index ?? selected] as { emoji: string }).emoji);
        break;
    }
    setAutocompleteState(null);
  };

  const StandardAutocompleteEntry = (props: ParentProps<{ idx: number }>) => (
    <div
      classList={{
        "flex items-center px-1 py-1.5 cursor-pointer transition duration-200 rounded-lg": true,
        "bg-2": props.idx === autocompleteState()?.selected,
      }}
      onClick={() => executeAutocomplete(props.idx)}
      onMouseOver={() => setAutocompleteSelection(props.idx)}
    >
      {props.children}
    </div>
  );

  const handleEmojiSelect = (emoji: string) => {
    if (!messageInputRef) return;
    if (document.activeElement !== messageInputRef) {
      messageInputRef.focus();
    }

    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);

    if (range && messageInputRef) {
      const textNode = document.createTextNode(emoji);
      range.insertNode(textNode);

      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection?.removeAllRanges();
      selection?.addRange(range);

      messageInputRef.focus();
      updateSendable();

      const event = window.event as MouseEvent;
      if (!event || !event.shiftKey) {
        setEmojiPickerVisible(false);
      }
    }
  };

  const isMessageMentioned = (message: Message) => {
    const clientId = api.cache?.clientId;
    if (!clientId || !message.mentions?.length) return false;

    const mentions = message.mentions.map(BigInt);
    if (mentions.includes(clientId)) return true;

    const channel = api.cache?.channels.get(message.channel_id);
    if (!channel || !("guild_id" in channel)) return false;
    if (!message.author_id) return false;

    const hasPrivileged =
      api.cache
        ?.getMemberPermissions(channel.guild_id, message.author_id, message.channel_id)
        ?.has("PRIVILEGED_MENTIONS") ?? false;

    if (mentions.includes(channel.guild_id)) return hasPrivileged;

    const roles = api.cache?.getMemberRoles(channel.guild_id, clientId) ?? [];
    for (const role of roles) {
      if (!mentions.includes(role.id)) continue;
      const mentionable = RoleFlags.fromValue(role.flags).has("MENTIONABLE");
      if (mentionable || hasPrivileged) return true;
    }

    return false;
  };

  const windowRange = createMemo(() =>
    windowStartId() == null || windowEndId() == null
      ? { start: 0, end: 0 }
      : resolveWindowIndices(messages(), windowStartId(), windowEndId())
  );

  const renderedMessages = createMemo(() => {
    const range = windowRange();
    return messages().slice(range.start, range.end);
  });
  const messageById = createMemo(() => {
    const map = new Map<bigint, Message>();
    for (const message of messages()) map.set(message.id, message);
    return map;
  });
  const resolveMessageById = (id: bigint) => messageById().get(id);

  const showStartHeader = createMemo(() => reachedOldest() && !loading());
  const isEmpty = createMemo(() => !loading() && messages().length === 0);

  const [renderBlocksStore, setRenderBlocksStore] = createStore<RenderBlock[]>([]);
  const renderBlocks = () => renderBlocksStore;

  createEffect(() => {
    if (loading()) {
      setRenderBlocksStore(reconcile([] as RenderBlock[], { key: "id" }));
      return;
    }
    const blocks: RenderBlock[] = [];
    if (showStartHeader()) blocks.push({ type: "header", id: "header" });

    const slice = renderedMessages();
    if (slice.length === 0) {
      setRenderBlocksStore(reconcile(blocks, { key: "id" }));
      return;
    }

    let lastMessage: Message | undefined;
    for (const message of slice) {
      const timestamp = snowflakes.timestamp(message.id);
      if (!lastMessage) {
        blocks.push({ type: "group", id: message.id.toString(), messageIds: [message.id] });
        lastMessage = message;
        continue;
      }

      const lastTimestamp = snowflakes.timestamp(lastMessage.id);
      const newDay = !isSameDay(timestamp, lastTimestamp);
      const sameAuthor = message.author_id === lastMessage.author_id;
      const withinWindow =
        snowflakes.timestampMillis(message.id) - snowflakes.timestampMillis(lastMessage.id)
        <= GROUP_WINDOW_MS;
      const isReply = !!message.references?.length;

      if (newDay) {
        blocks.push({ type: "divider", id: `divider-${message.id}`, content: humanizeDate(timestamp) });
      }

      if (!sameAuthor || !withinWindow || newDay || isReply) {
        blocks.push({ type: "group", id: message.id.toString(), messageIds: [message.id] });
      } else {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock.type === "group") lastBlock.messageIds.push(message.id);
      }

      lastMessage = message;
    }

    setRenderBlocksStore(reconcile(blocks, { key: "id" }));
  });

  const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: (() => renderBlocks().length) as unknown as number,
    getScrollElement: () => messageAreaRef!,
    estimateSize: () => 84,
    overscan: 12,
  } as any);

  createEffect(() => {
    const channelId = props.channelId;
    const initialMessageId = untrack(messageId);

    if (previousChannelId && previousChannelId !== channelId) {
      channelState.set(previousChannelId, {
        reachedOldest: reachedOldest(),
        reachedNewest: reachedNewest(),
      });
    }
    previousChannelId = channelId;
    const savedState = channelState.get(channelId);

    setLoading(true);
    setReachedOldest(savedState?.reachedOldest ?? false);
    setReachedNewest(savedState?.reachedNewest ?? false);
    setWindowStartId(null);
    setWindowEndId(null);
    setJumpHighlightId(null);
    setLastJumpedId(null);
    setLastAckedId(null);
    setFetchingOlder(false);
    setFetchingNewer(false);
    setFetchingAround(false);
    setFetchingLatest(false);
    setScrollAnchor("newest");
    setAutocompleteState(null);
    setUploadedAttachments([]);
    setReplyingTo([]);
    setSendable(false);
    setEmojiPickerVisible(false);
    setMessageInputFocused(false);
    setMessageInputFocusTimeout(null);
    editing.clear();
    if (messageInputRef) messageInputRef.innerText = "";
    lastFetchStartedAt = 0;
    lastHistoryRequestAt = 0;
    lastAtTop = false;
    lastAtBottom = false;

    void (async () => {
      await new Promise(requestAnimationFrame);
      if (props.channelId !== channelId) return;
      const list = untrack(messages);
      if (initialMessageId) {
        if (findExactIndex(list, initialMessageId) === -1) await fetchAround(initialMessageId);
        if (props.channelId !== channelId) return;
        untrack(() => setWindowAround(initialMessageId));
        setLoading(false);
        await untrack(() => handleJump(initialMessageId));
        return;
      }

      if (list.length > 0) {
        untrack(() => setWindowToLatest());
        setReachedNewest(true);
        setLoading(false);
        queueMicrotask(() => {
          if (messageAreaRef) messageAreaRef.scrollTo({ top: messageAreaRef.scrollHeight });
        });
      } else {
        await fetchLatest();
        if (props.channelId !== channelId) return;
        queueMicrotask(() => {
          if (messageAreaRef) messageAreaRef.scrollTo({ top: messageAreaRef.scrollHeight });
        });
      }
    })();
  });

  createEffect(() => {
    const targetId = messageId();
    if (!targetId) return;
    if (loading()) return;
    if (targetId === lastJumpedId()) return;
    void untrack(() => handleJump(targetId));
  });

  const handleScroll = () => {
    if (loading()) return;
    if (isFetching()) return;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(() => {
      if (!messageAreaRef) return;
      if (isFetching()) return;
      const distanceFromBottom =
        messageAreaRef.scrollHeight - messageAreaRef.clientHeight - messageAreaRef.scrollTop;
      const atTop = messageAreaRef.scrollTop < SCROLL_FETCH_THRESHOLD_PX;
      const atBottom = distanceFromBottom < SCROLL_FETCH_THRESHOLD_PX;
      const enteringTop = atTop && !lastAtTop;
      const enteringBottom = atBottom && !lastAtBottom;

      if (atTop && atBottom) {
        if (scrollAnchor() === "oldest" && enteringTop) {
          void maybeLoadOlder();
        } else if (scrollAnchor() === "newest" && enteringBottom) {
          void maybeLoadNewer();
        }
      } else if (enteringTop) {
        setScrollAnchor("oldest");
        void maybeLoadOlder();
      }
      if (!atTop && enteringBottom) {
        setScrollAnchor("newest");
        void maybeLoadNewer();
        void ack();
      }

      updateScrollIndicators(distanceFromBottom);
      lastAtTop = atTop;
      lastAtBottom = atBottom;
    });
  };

  const scrollToBottom = async () => {
    setScrollAnchor("newest");
    if (!reachedNewest()) {
      await fetchLatest();
    } else {
      setWindowToLatest();
    }
    queueMicrotask(() => {
      messageAreaRef?.scrollTo({ top: messageAreaRef.scrollHeight, behavior: "smooth" });
    });
  };

  return (
    <div class="flex flex-col justify-end w-full h-0 flex-grow relative">
      <div
        ref={(el) => {
          messageAreaRef = el!;
          rowVirtualizer.setOptions({
            ...rowVirtualizer.options,
            getScrollElement: () => messageAreaRef!,
          });
        }}
        class="overflow-auto pb-5 relative"
        onScroll={handleScroll}
        onClick={ack}
        onFocus={ack}
      >
        <Show when={showScrollToBottom()}>
          <div class="fixed justify-self-center top-24 w-full flex justify-center z-10">
            <button
              class="btn bg-accent hover:bg-accent/90 font-title text-white py-2 px-4 rounded-full gap-2"
              onClick={scrollToBottom}
            >
              <Icon icon={ArrowDown} class="w-4 h-4 fill-white" />
              {t('chat.jump_to_newer')}
            </button>
          </div>
        </Show>

        <div class="flex flex-col gap-y-4">
          <Show when={loading()}>
            <MessageLoadingSkeleton />
          </Show>
          <Show when={!loading()}>
            <Show when={fetchingOlder()}>
              <MessageLoadingSkeleton count={3} />
            </Show>
            <Show when={renderBlocks().length > 0}>
              <Show
                when={rowVirtualizer.getVirtualItems().length > 0}
                fallback={
                  <div class="flex flex-col gap-y-4">
                    <For each={renderBlocks()}>
                      {(block) => (
                        <MessageGroupView
                          block={block}
                          guildId={props.guildId}
                          grouper={grouper()}
                          editing={editing}
                          title={props.title}
                          startMessage={props.startMessage}
                          messageById={resolveMessageById}
                          isMentioned={isMessageMentioned}
                          isJumpHighlight={(id) => jumpHighlightId() === id}
                          onReply={addReply}
                        />
                      )}
                    </For>
                  </div>
                }
              >
                <div
                  class="relative w-full"
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  <For each={rowVirtualizer.getVirtualItems()}>
                    {(virtualRow) => {
                      const index = virtualRow.index;
                      const block = () => renderBlocks()[index];
                      return (
                        <div
                          ref={(el) => rowVirtualizer.measureElement(el)}
                          data-index={index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <div class="pb-4">
                            <MessageGroupView
                              block={block()}
                              guildId={props.guildId}
                              grouper={grouper()}
                              editing={editing}
                              title={props.title}
                              startMessage={props.startMessage}
                              messageById={resolveMessageById}
                              isMentioned={isMessageMentioned}
                              isJumpHighlight={(id) => jumpHighlightId() === id}
                              onReply={addReply}
                            />
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={fetchingNewer()}>
              <MessageLoadingSkeleton count={3} />
            </Show>
          </Show>
        </div>
      </div>
      <div class="ml-11 mr-2 relative">
        <div
          classList={{
            "absolute inset-x-4 bottom-2 rounded-xl bg-0 p-2 flex flex-col z-[110]": true,
            hidden: !autocompleteResult()?.length,
          }}
        >
          <Switch>
            <Match when={autocompleteState()?.type === AutocompleteType.UserMention}>
              <For each={autocompleteResult() as User[]}>
                {(user, idx) => (
                  <StandardAutocompleteEntry idx={idx()}>
                    <img src={api.cache!.avatarOf(user.id)} class="w-6 h-6 rounded-full" alt="" />
                    <div class="mx-2 flex-grow text-sm flex justify-between">
                      <span>{displayName(user)}</span>
                      <Show when={user.display_name != null}>
                        <span class="text-fg/60">@{user.username}</span>
                      </Show>
                    </div>
                  </StandardAutocompleteEntry>
                )}
              </For>
            </Match>

            <Match when={autocompleteState()?.type === AutocompleteType.ChannelMention}>
              <For each={autocompleteResult() as GuildChannel[]}>
                {(channel, idx) => (
                  <StandardAutocompleteEntry idx={idx()}>
                    <Icon icon={Hashtag} class="w-5 h-5 fill-fg/60" />
                    <div class="ml-2 text-sm">
                      <span>{channel.name}</span>
                      <Show when={channel.guild_id != props.guildId}>
                        <span class="text-fg/60 text-sm">
                          &nbsp;in <b>{api?.cache?.guilds?.get(channel.guild_id)?.name}</b>
                        </span>
                      </Show>
                    </div>
                  </StandardAutocompleteEntry>
                )}
              </For>
            </Match>

            <Match when={autocompleteState()?.type === AutocompleteType.Emoji}>
              <For each={autocompleteResult() as any[]}>
                {(emoji, idx) => (
                  <StandardAutocompleteEntry idx={idx()}>
                    <img class="ml-1" src={emoji.url} alt="" width={20} height={20} />
                    <div class="ml-2 text-sm flex flex-grow justify-between">
                      <span>:{emoji.name}:</span>
                      <span class="text-fg/60 text-sm mx-2">{emoji.category}</span>
                    </div>
                  </StandardAutocompleteEntry>
                )}
              </For>
            </Match>
          </Switch>
        </div>
      </div>
      <Show
        when={canSendMessages()}
        fallback={
          <div class="p-4 mx-2 -mb-3 text-fg/60 rounded-xl bg-bg-0/70">
            {t('chat.no_permission')}
          </div>
        }
      >
        <div class="relative flex items-start w-full px-4">
          <div
            ref={emojiPickerRef}
            class="absolute right-4 bottom-[calc(100%+0.5rem)] z-[200] transition-all duration-200 origin-bottom"
            classList={{
              "opacity-0 translate-y-2 pointer-events-none": !emojiPickerVisible(),
              "opacity-100 translate-y-0": emojiPickerVisible(),
            }}
          >
            <EmojiPicker onSelect={handleEmojiSelect} />
          </div>
          <button
            class="w-9 h-9 flex flex-shrink-0 items-center justify-center rounded-full bg-3 mr-2 transition-all duration-200 hover:bg-accent"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.multiple = true;
              input.accept = "*";
              input.addEventListener("change", async () => {
                const files = input.files;
                if (!files) return;

                const uploaded = await Promise.all(
                  Array.from(files, async (file) => {
                    const attachment: UploadedAttachment = {
                      filename: file.name,
                      type: file.type,
                      file,
                    };
                    if (file.type.startsWith("image/")) {
                      attachment.preview = URL.createObjectURL(file);
                    }
                    return attachment;
                  })
                );
                setUploadedAttachments((prev) => [...prev, ...uploaded]);
                updateSendable();
              });
              input.click();
              messageInputRef?.focus();
            }}
            use:tooltip={t('generic.upload')}
          >
            <Icon icon={Plus} title={t('generic.upload')} class="fill-fg w-[18px] h-[18px]" />
          </button>
          <div
            classList={{
              "w-full bg-3 rounded-lg py-2 max-h-[40vh] overflow-y-auto": true,
              "w-[calc(100%-5.75rem)]": mobile,
              "w-[calc(100%-2.75rem)]": !mobile,
            }}
          >
            <Show when={replyingTo().length > 0} keyed={false}>
              <div class="flex flex-col gap-y-1 px-2">
                <For each={replyingTo()}>
                  {({ message: msg, mentionAuthor }) => {
                    const icon = msg.author?.avatar ?? api.cache!.avatarOf(msg.author_id!);
                    const name = displayName(
                      msg.author ?? api.cache!.users.get(msg.author_id!) ?? authorDefault()
                    );
                    return (
                      <div class="flex items-center bg-2 rounded p-1 text-xs gap-2">
                        <img src={icon} alt={name} class="w-6 h-6 rounded-full flex-shrink-0" />
                        <span class="truncate flex-grow">
                          <b>{name}</b>
                          {msg.content ? `: ${msg.content}` : ""}
                        </span>
                        <button
                          class="p-1 rounded-full hover:bg-fg/10"
                          onClick={() => setMentionAuthor(msg, !mentionAuthor)}
                          use:tooltip={mentionAuthor ? t('chat.do_not_mention_when_replying', { name }) : t('chat.mention_when_replying', { name })}
                        >
                          <Icon
                            icon={At}
                            class="w-3 h-3 transition-all duration-200"
                            classList={{ [mentionAuthor ? "fill-fg/100" : "fill-fg/60"]: true }}
                          />
                        </button>
                        <button
                          class="p-1 rounded-full hover:bg-fg/10"
                          onClick={() => removeReply(msg.id)}
                          use:tooltip={t('generic.remove')}
                        >
                          <Icon icon={Xmark} class="w-3 h-3 fill-fg/60" />
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
              <div class="divider m-0 p-0" />
            </Show>
            <Show when={uploadedAttachments().length > 0} keyed={false}>
              <div class="flex flex-wrap gap-x-2 gap-y-1 px-2">
                <For each={uploadedAttachments()}>
                  {(attachment, idx) => (
                    <div class="flex flex-col rounded-xl bg-2 w-52 h-40 overflow-hidden box-border relative group">
                      <div
                        class="absolute inset-0 flex items-center justify-center gap-x-2 bg-bg-0/70 opacity-0
                          group-hover:opacity-100 transition-all duration-200 group-hover:backdrop-blur-md overflow-hidden
                          box-border rounded-xl"
                      >
                        <button
                          class="rounded-full p-4 bg-transparent hover:bg-danger transition-all duration-200"
                          onClick={() => {
                            setUploadedAttachments((prev) => prev.filter((_, i) => i !== idx()));
                            updateSendable();
                          }}
                        >
                          <Icon icon={Trash} class="w-5 h-5 fill-fg" />
                        </button>
                      </div>
                      <div class="overflow-hidden w-52 h-[6.75rem]">
                        {attachment.preview ? (
                          <img
                            src={attachment.preview}
                            alt={attachment.filename}
                            class="w-60 h-[6.75rem] object-contain"
                          />
                        ) : (
                          <span class="w-full h-full flex items-center justify-center text-fg/60 p-2 bg-0 break-words">
                            {attachment.type || attachment.filename}
                          </span>
                        )}
                      </div>
                      <div class="break-words flex-grow p-2 bg-1">
                        <h2 class="text-sm font-title font-medium">
                          {attachment.filename}
                        </h2>
                        <div class="text-xs text-fg/60">
                          {humanizeSize(attachment.file.size)}{" "}
                          {attachment.alt && <> - {attachment.alt}</>}
                        </div>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={uploadedAttachments().length > 1} keyed={false}>
                  <div class="self-center justify-self-center text-fg/60">
                    ={" "}
                    {humanizeSize(
                      uploadedAttachments().reduce((acc, cur) => acc + cur.file.size, 0)
                    )}
                  </div>
                </Show>
              </div>
              <div class="divider m-0 p-0" />
            </Show>
            <div
              id="message-input"
              ref={messageInputRef!}
              class="mx-2 empty:before:content-[attr(data-placeholder)] text-sm empty:before:text-fg/50 outline-none break-words"
              contentEditable
              data-placeholder={t('chat.message_input_placeholder')}
              spellcheck={false}
              onPaste={async (event) => {
                event.preventDefault();

                const types = event.clipboardData?.types;
                if (types?.includes("Files")) {
                  const files = event.clipboardData?.files;
                  if (!files) return;

                  const uploaded = await Promise.all(
                    Array.from(files, async (file) => {
                      const attachment: UploadedAttachment = {
                        filename: file.name,
                        type: file.type,
                        file,
                      };
                      if (file.type.startsWith("image/")) {
                        attachment.preview = URL.createObjectURL(file);
                      }
                      return attachment;
                    })
                  );
                  setUploadedAttachments((prev) => [...prev, ...uploaded]);
                }

                if (types?.includes("text/plain")) {
                  const text = event.clipboardData?.getData("text/plain");
                  if (!text) return;

                  document.execCommand("insertText", false, text);
                }
                updateSendable();
              }}
              onKeyUp={(event) => {
                const oldState = autocompleteState();
                if (oldState) {
                  if (event.key === "ArrowUp") return setAutocompleteSelection(oldState.selected - 1);
                  if (event.key === "ArrowDown") return setAutocompleteSelection(oldState.selected + 1);
                }

                handleCaretUpdate();
              }}
              onKeyDown={(event) => {
                const oldState = autocompleteState();
                if (oldState && (event.key === "ArrowUp" || event.key === "ArrowDown"))
                  event.preventDefault();
                else if (event.key === "ArrowUp" && !event.currentTarget.innerText?.trim()) {
                  event.preventDefault();
                  const lastMessage = grouper().latestMessageWhere(
                    (message) => message.author_id === api.cache?.clientId
                  );
                  if (lastMessage && lastMessage.author_id == api.cache?.clientId)
                    editing.add(lastMessage.id);
                }
              }}
              onKeyPress={async (event) => {
                if (event.shiftKey) return;

                if (event.key === "Enter" && (!mobile || event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  if (autocompleteState() && autocompleteResult()?.length) return executeAutocomplete();
                  await createMessage();
                }
              }}
              onMouseUp={handleCaretUpdate}
              onTouchStart={handleCaretUpdate}
              onSelect={handleCaretUpdate}
              onInput={() => {
                void typingKeepAlive().ackTyping();
                updateSendable();
                handleCaretUpdate();
              }}
              onFocus={() => {
                const timeout = messageInputFocusTimeout();
                if (timeout) clearTimeout(timeout);

                setMessageInputFocused(true);
                void ack();
              }}
              onBlur={() =>
                setMessageInputFocusTimeout(
                  setTimeout(() => setMessageInputFocused(false), 100) as any
                )
              }
            />
          </div>
          <button
            ref={emojiToggleRef}
            class="w-9 h-9 flex flex-shrink-0 items-center justify-center rounded-full hover:bg-accent ml-2 transition-all duration-200"
            classList={{
              "bg-accent": emojiPickerVisible(),
              "bg-3": !emojiPickerVisible(),
            }}
            use:tooltip={t('chat.add_emoji')}
            onClick={() => setEmojiPickerVisible(!emojiPickerVisible())}
          >
            <Icon icon={FaceSmile} class="fill-fg w-[18px] h-[18px]" />
          </button>
          <button
            class="w-9 h-9 flex flex-shrink-0 items-center justify-center rounded-full bg-3 ml-2 transition-all duration-200"
            classList={{
              "opacity-50 cursor-not-allowed": !sendable(),
              "hover:bg-accent": sendable(),
              hidden: !mobile,
            }}
            use:tooltip={t('chat.send')}
            onClick={async () => {
              if (messageInputFocused()) messageInputRef?.focus();
              await createMessage();
            }}
          >
            <Icon icon={PaperPlaneTop} title={t('chat.send')} class="fill-fg w-[18px] h-[18px]" />
          </button>
        </div>
      </Show>
      <div class="mx-4 h-5 text-xs flex-shrink-0">
        <Show when={typing().users.size > 0}>
          <For
            each={[...typing().users]
              .map((id) => api.cache?.users.get(id)?.username)
              .filter((username): username is string => !!username)}
          >
            {(username, index) => (
              <>
                <span class="font-bold">{username}</span>
                {index() < typing().users.size - 1 && typing().users.size > 2 && (
                  <span class="text-fg/50">, </span>
                )}
                {index() === typing().users.size - 2 && <span class="text-fg/50"> and </span>}
              </>
            )}
          </For>
          <span class="text-fg/50 font-medium">
            {" "}
            {typing().users.size === 1 ? t('chat.typing_suffix_is') : t('chat.typing_suffix_are')}
          </span>
        </Show>
      </div>
    </div>
  );
}
