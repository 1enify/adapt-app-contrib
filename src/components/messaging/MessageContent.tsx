import { getApi } from "../../api/Api";
import type MessageGrouper from "../../api/MessageGrouper";
import type { Message } from "../../types/message";
import type { Invite } from "../../types/guild";
import { humanizeSize, humanizeTimeDelta, mapIterator, uuid } from "../../utils";

import GuildIcon from "../guilds/GuildIcon";
import { joinGuild } from "../../pages/guilds/Invite";
import { DynamicMarkdown } from "./Markdown";

import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { ReactiveSet } from "@solid-primitives/set";
import toast from "solid-toast";

import Icon from "../icons/Icon";
import Users from "../icons/svg/Users";
import UserPlus from "../icons/svg/UserPlus";
import Plus from "../icons/svg/Plus";

import tooltip from "../../directives/tooltip";
void tooltip;

const CONVEY = 'https://convey.adapt.chat';
const INVITE_REGEX = /https:\/\/adapt\.chat\/invite\/([a-zA-Z0-9]+)/g;

function shouldDisplayImage(filename: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].some((ext) => filename.endsWith(ext))
}

export type MessageContentProps = {
  message: Message,
  grouper?: MessageGrouper,
  editing?: ReactiveSet<bigint>,
  largePadding?: boolean
}

export default function MessageContent(props: MessageContentProps) {
  const message = () => props.message
  const largePadding = () => props.largePadding
  const navigate = useNavigate()

  const api = getApi()!
  const [invites, setInvites] = createSignal<Invite[]>([])
  onMount(() => {
    const codes = new Set(
      mapIterator(message().content?.matchAll(INVITE_REGEX) ?? [], (match) => match[1])
    )
    if (codes.size == 0) return

    let tasks = [...codes].slice(0, 5).map(async (code) => {
      const cached = api.cache!.invites.get(code)
      if (cached) return cached

      const response = await api.request('GET', `/invites/${code}`)
      if (!response.ok) return null

      const invite: Invite = response.jsonOrThrow()
      api.cache!.invites.set(code, invite)
      return invite
    })
    Promise.all(tasks).then((invites) => {
      setInvites(invites.filter((invite): invite is Invite => !!invite))
    })
  })

  let editAreaRef: HTMLDivElement | null = null
  const editMessage = async () => {
    const editedContent = editAreaRef!.innerText!.trim()
    if (!editedContent) return

    const msg = {
      ...message(),
      content: editedContent,
      _nonceState: 'pending',
    } satisfies Message;
    props.grouper?.editMessage(msg.id, msg)

    const response = await api.request('PATCH', `/channels/${message().channel_id}/messages/${message().id}`, {
      json: { content: editedContent }
    })
    if (!response.ok) {
      toast.error(`Failed to edit message: ${response.errorJsonOrThrow().message}`)
    }
  }
  createEffect(() => {
    if (props.editing?.has(message().id)) {
      editAreaRef!.innerText = message().content!
      editAreaRef!.focus()
    }
  })

  return (
    <span
      data-message-id={message().id}
      class="break-words text-sm font-light overflow-hidden"
      classList={{
        "text-fg/50": message()._nonceState === 'pending',
        "text-danger": message()._nonceState === 'error',
      }}
      style={{
        width: largePadding()
          ? "calc(100% - 4.875rem)"
          : "calc(100% - 1rem)",
      }}
    >
      <Show when={props.editing?.has(message().id)} fallback={
        <Show when={message().content}>
          <div
            class="break-words"
            classList={{ "[&>*:nth-last-child(2)]:inline-block message-content-root": !!message().edited_at }}
          >
            <DynamicMarkdown content={message().content!} />
            <Show when={message().edited_at}>
              <span
                class="ml-1 inline-block text-xs text-fg/40"
                use:tooltip={`Edited ${humanizeTimeDelta(Date.now() - Date.parse(message().edited_at!))} ago`}>
                (edited)
              </span>
            </Show>
          </div>
        </Show>
      }>
        <div
          ref={editAreaRef!}
          contentEditable={true}
          class="break-words text-sm font-light overflow-auto rounded-lg bg-bg-3/50 p-2 my-0.5
            empty:before:content-[attr(data-placeholder)] empty:before:text-fg/50
            focus:outline-none border-2 focus:border-accent border-transparent transition"
          data-placeholder="Edit this message..."
          onKeyDown={async (e) => {
            if (e.key == 'Enter' && !e.shiftKey || e.key == 'Escape') {
              e.preventDefault()
              props.editing?.delete(message().id)
              if (e.key == 'Enter') await editMessage()
            }
          }}
        />
      </Show>
      <For each={message().embeds}>
        {(embed) => (
          <div class="rounded overflow-hidden inline-flex my-1">
            <div class="inline-flex flex-col p-2.5 border-l-4" style={{
              'background-color': embed.hue != null
                ? `color-mix(in srgb, rgb(var(--c-bg-0)), hsl(${embed.hue * 3.6}, 35%, 50%) 25%)`
                : 'rgb(var(--c-bg-0))',
              'border-left-color': embed.color != null
                ? '#' + embed.color!.toString(16).padStart(6, '0')
                : 'rgb(var(--c-accent))',
            }}>
              <Show when={embed.author}>
                <a
                  classList={{
                    "flex items-center text-fg/70 font-normal": true,
                    "hover:underline underline-offset-2": !!embed.author!.url,
                    "mb-0.5": !!embed.author!.icon_url && !embed.title,
                    "mb-1.5": !embed.title,
                  }}
                  href={embed.author!.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Show when={embed.author!.icon_url}>
                    <img src={embed.author!.icon_url!} alt="" class="mr-1 w-5 h-5 rounded-full" />
                  </Show>
                  <DynamicMarkdown content={embed.author!.name} />
                </a>
              </Show>
              <Show when={embed.title}>
                <a
                  classList={{
                    "text-lg font-medium font-title py-0.5 md:min-w-[128px]": true,
                    "hover:underline underline-offset-2": !!embed.url,
                  }}
                  href={embed.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <DynamicMarkdown content={embed.title!} />
                </a>
              </Show>
              <Show when={embed.description}>
                <div class="text-fg/80 text-sm">
                  <DynamicMarkdown content={embed.description!} />
                </div>
              </Show>
              <Show when={embed.footer}>
                <div class="flex items-center text-fg/50 text-xs mt-1.5">
                  <Show when={embed.footer!.icon_url}>
                    <img src={embed.footer!.icon_url!} alt="" class="mr-1 w-5 h-5 rounded-full" />
                  </Show>
                  <DynamicMarkdown content={embed.footer!.text} />
                </div>
              </Show>
            </div>
          </div>
        )}
      </For>
      {/* Attachments */}
      <For each={message().attachments}>
        {(attachment) => (
          <div classList={{
            "mt-1 inline-block box-border rounded-lg overflow-hidden max-h-96 cursor-pointer": true,
            "opacity-50": message()._nonceState === 'pending',
            "opacity-30": message()._nonceState === 'error',
          }}>
            {(() => {
              const url = attachment.id && CONVEY + `/attachments/compr/${uuid(attachment.id)}/${attachment.filename}`
              return shouldDisplayImage(attachment.filename) ? (
                <img
                  src={attachment._imageOverride ?? url}
                  alt={attachment.alt}
                  class="max-w-[clamp(56rem,60vw,90%)] max-h-80 object-contain object-left"
                />
              ) : (
                <div class="flex justify-between bg-0 w-[min(60vw,24rem)] p-4 rounded-lg">
                  <div>
                    <a
                      class="text-lg font-medium font-title hover:underline"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {attachment.filename}
                    </a>
                    <div class="text-fg/60 text-sm">{humanizeSize(attachment.size)}</div>
                  </div>
                </div>
              )
            })()}
          </div>
        )}
      </For>
      {/* Invites */}
      <For each={invites()}>
        {(invite) => (
          <div class="my-1 bg-0 rounded-lg p-4 max-w-[360px] overflow-hidden relative [&_*]:z-[1]">
            <Show when={invite.guild?.banner}>
              <img src={invite.guild?.banner} alt="" class="absolute inset-0 opacity-25" />
            </Show>
            <p class="pb-2 flex items-center justify-center text-xs text-fg/40 font-title">
              <Icon icon={UserPlus} class="w-5 h-5 mr-2 fill-fg/40" />
              <span>You've been invited to join a server!</span>
            </p>
            <div class="flex gap-x-3 items-start">
              <GuildIcon guild={invite!.guild!} pings={0} unread={false} sizeClass="w-16 h-16 text-lg" />
              <div class="flex flex-col flex-grow">
                <h1 class="font-title text-lg font-medium">{invite.guild?.name}</h1>
                <Show when={invite.guild?.description}>
                  <p class="text-fg/50 text-sm">{invite.guild?.description}</p>
                </Show>
                <p class="select-none opacity-50 flex items-center">
                  <Icon icon={Users} class="w-4 h-4 mr-1 fill-fg" />
                  {invite.guild?.member_count?.total} Member{invite.guild?.member_count?.total === 1 ? '' : 's'}
                </p>
                <button class="btn btn-primary btn-sm mt-2" onClick={() => joinGuild(invite.code, navigate)}>
                  <Icon icon={Plus} class="w-4 h-4 mr-1 fill-fg" />
                  Join Server
                </button>
              </div>
            </div>
          </div>
        )}
      </For>
      {/* Error */}
      <Show when={message()._nonceError} keyed={false}>
        <p class="inline-block p-2 bg-danger/20 rounded-lg text-sm font-medium">
          <b>Error: </b>
          {message()._nonceError}
        </p>
      </Show>
    </span>
  )
}