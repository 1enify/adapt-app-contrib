import Api, {getApi} from "../../api/Api";
import {For, Show} from "solid-js";
import {FriendEntry, RelationshipDeleteButton, relationshipFilterFactory} from "./Requests";
import {useNavigate, type Navigator} from "@solidjs/router";
import tooltip from "../../directives/tooltip";
import {findIterator, noop} from "../../utils";
import {ChannelCreateEvent} from "../../types/ws";
import {Channel} from "../../types/channel";
import MessageIcon from "../../components/icons/svg/Message";
import Icon from "../../components/icons/Icon";
import Header from "../../components/ui/Header";
import {FriendsNav} from "./Friends";
import {t} from "../../i18n";
noop(tooltip)

export async function openDms(api: Api, navigate: Navigator, userId: bigint, effect?: () => void) {
  const predicate = (channel: Channel) => channel.type === 'dm' && channel.recipient_ids.includes(userId)
  const found = findIterator(api.cache?.channels.values(), predicate)
  if (found) {
    effect?.()
    return navigate(`/dms/${found.id}`)
  }
  api.ws?.on('channel_create', ({ channel }: ChannelCreateEvent, remove) => {
    if (predicate(channel)) {
      effect?.()
      navigate(`/dms/${channel.id}`)
      remove()
    }
  })
  await api.request('POST', `/users/me/channels`, {
    json: { type: 'dm', recipient_id: userId }
  })
}

export default function FriendsList() {
  const api = getApi()!
  const friends = relationshipFilterFactory(api, 'friend')
  const navigate = useNavigate()

  return (
    <div class="p-2 h-full flex flex-col overflow-auto">
      <Header>
        <FriendsNav />
      </Header>
      <Show when={friends().length} fallback={(
        <div class="text-center font-medium text-fg/60 p-4">
          {t('friends.no_friends.remark')}
          <button
            class="ml-2 btn btn-sm btn-primary"
            onClick={() => document.getElementById('add-friend')?.click()}
          >
            {t('friends.no_friends.action')}
          </button>
        </div>
      )}>
        <div class="divider font-title font-medium text-fg/60 mx-2 my-2">
          {t('friends.dividers.all', { count: friends().length })}
        </div>
        <For each={friends()}>
          {([id, _], index) => (
            <FriendEntry api={api} id={id} index={index}>
              <button
                class="p-2.5 rounded-full bg-bg-3/70 hover:bg-accent transition duration-200"
                onClick={() => openDms(api, navigate, id)}
                use:tooltip={{ content: t('friends.actions.dm'), placement: 'left' }}
              >
                <Icon icon={MessageIcon} title={t('friends.actions.dm')} class="w-3.5 h-3.5 fill-fg"/>
              </button>
              <RelationshipDeleteButton api={api} id={id} label={t('friends.actions.unfriend')} />
            </FriendEntry>
          )}
        </For>
      </Show>
    </div>
  )
}
