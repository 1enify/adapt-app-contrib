import { useNavigate, useParams } from "@solidjs/router"
import { getApi } from "../../api/Api"
import { createMemo, For, Show } from "solid-js"
import { User } from "../../types/user"
import SidebarSection from "../ui/SidebarSection"
import useContextMenu from "../../hooks/useContextMenu"
import StatusIndicator from "../users/StatusIndicator"
import { displayName } from "../../utils"
import { UserFlags } from "../../api/Bitflags"
import { GroupDmChannel } from "../../types/channel"
import Crown from "../icons/svg/Crown"
import Icon from "../icons/Icon"

export default function GroupMemberList() {
  const api = getApi()!
  const cache = api.cache!
  const params = useParams<{ channelId: string }>()
  const channelId = () => BigInt(params.channelId!)
  const channel = createMemo(() => cache.channels.get(channelId()))
  const recipients = createMemo(() => {
    const c = channel()
    if (!c || c.type !== 'group') return []
    return c.recipient_ids
      .map(id => cache.users.get(id))
      .filter((u): u is User => !!u)
  })
  const getPresence = (user: User) => cache.presences.get(user.id)
  const getStatus = (user: User) => {
    const presence = getPresence(user)
    return presence ? presence.status : 'offline'
  }

  return (
    <div class="flex flex-col w-full">
      <SidebarSection badge={() => recipients().length}>
        Members
      </SidebarSection>
      <For each={recipients()}>
        {(user) => (
          <div
            class="group flex items-center px-2 py-1.5 rounded-lg hover:bg-3 transition duration-200 cursor-pointer"
          >
            <div class="indicator flex-shrink-0">
              <StatusIndicator status={getStatus(user)} tailwind="m-[0.2rem] w-2.5 h-2.5" indicator />
              <img
                src={cache.avatarOf(user.id)}
                alt=""
                classList={{
                  "w-8 h-8 rounded-full": true,
                  "filter grayscale group-hover:grayscale-0 transition duration-1000": getStatus(user) === 'offline',
                }}
              />
            </div>
            <div class="flex flex-col ml-3 flex-grow min-w-0">
              <span class="flex items-center gap-x-1.5 text-sm">
                <span
                  class="truncate min-w-0"
                  classList={{
                    "opacity-60": getStatus(user) === 'offline',
                    "!opacity-80": getStatus(user) !== 'offline',
                  }}
                >
                  {displayName(user)}
                </span>
                <Show when={UserFlags.fromValue(user.flags).has('BOT')}>
                  <span class="text-xs rounded px-1 py-[1px] bg-accent">BOT</span>
                </Show>
              </span>
              <Show when={getPresence(user)?.custom_status}>
                <span class="text-xs text-fg/60 truncate min-w-0">{getPresence(user)?.custom_status}</span>
              </Show>
            </div>
            <Show when={user.id == (channel() as GroupDmChannel).owner_id}>
              <Icon icon={Crown} class="w-4 h-4 fill-yellow-400" tooltip="Owner" />
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
