import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import Api, { getApi } from "../../api/Api";
import { ModalTemplate, useModal } from "../ui/Modal";
import { displayName, extendedColor, findIterator } from "../../utils";
import { relationshipFilterFactory } from "../../pages/friends/Requests";
import { Navigator, useNavigate } from "@solidjs/router";
import { openDms } from "../../pages/friends/FriendsList";
import { Channel } from "../../types/channel";
import { ChannelCreateEvent } from "../../types/ws";

export async function createGroupDm(
  api: Api, navigate: Navigator, name: string,recipientIds: bigint[], effect?: () => void
) {
  const desired = new Set(recipientIds);
  if (!recipientIds.includes(api.cache!.clientId!))
    desired.add(api.cache!.clientId!);

  const predicate = (channel: Channel) => {
    if (channel.type !== 'group') return false;
    const channelRecipientIds = new Set(channel.recipient_ids);

    if (channelRecipientIds.size !== desired.size) return false;
    for (const id of desired) if (!channelRecipientIds.has(id)) return false;

    return true;
  }

  api.ws?.on('channel_create', ({ channel }: ChannelCreateEvent, remove) => {
    if (predicate(channel)) {
      effect?.()
      navigate(`/dms/${channel.id}`)
      remove()
    }
  })
  await api.request('POST', `/users/me/channels`, {
    json: { type: 'group', name, recipient_ids: recipientIds }
  })
}

export default function NewConversationModal() {
  const api = getApi()!;
  const cache = api.cache!;
  const navigate = useNavigate();
  const { hideModal } = useModal();

  const friends = relationshipFilterFactory(api, 'friend')
  const resolvedFriends = createMemo(() => friends().map(([id, _]) => cache.users.get(id)!).filter(u => !!u));

  let nameInputRef: HTMLInputElement | null = null;
  const [selected, setSelected] = createSignal<bigint[]>([]);
  const [isCreating, setIsCreating] = createSignal<boolean>(false);
  const [name, setName] = createSignal<string>('');
  
  const toggle = (id: bigint) => setSelected(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]);
  const defaultName = () => {
    const recipients = [cache.clientId, ...selected()]
    const base = recipients.map(id => id && cache.users.get(id)?.username).filter(n => !!n).join(', ') || 'New Group';
    if (base.length > 32) return base.slice(0, 29) + '...';
    return base;
  }

  const effect = () => {
    console.log(hideModal)
    hideModal();
    setName('');
    setSelected([]);
    setIsCreating(false);
  }
  const startConversation = async () => {
    setIsCreating(true);
    if (selected().length === 1)
      await openDms(api, navigate, selected()[0], effect);
    else
      await createGroupDm(api, navigate, name() || defaultName(), selected(), effect);
  }
  const onSubmit = (e: Event) => {
    e.preventDefault();
    void startConversation();
  }

  return (
    <ModalTemplate title="New Conversation">
      <p class="text-sm mt-2 text-fg/60 text-center font-light">
        Select friends to start a new conversation with.
      </p>
      <form class="mt-4" onSubmit={onSubmit}>
        <div class="mb-4 max-h-80 sm:min-w-[320px] w-full overflow-auto pr-1">
          <For each={resolvedFriends()}>
            {(user) => (
              <label class="flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer transition hover:bg-fg/10">
                <div class="flex items-center gap-3">
                  <img src={cache.avatarOf(user.id)} alt="" class="w-6 h-6 rounded-full" />
                  <div class="font-title text-sm">
                    {displayName(user)}
                    <Show when={user.display_name}>
                      <span class="text-transparent group-hover:text-fg/40 transition ml-2">@{user.username}</span>
                    </Show>
                  </div>
                </div>
                <input
                  type="checkbox"
                  class="checkbox"
                  checked={selected().includes(user.id)}
                  onInput={() => toggle(user.id)}
                />
              </label>
            )}
          </For>
        </div>
        <Show when={selected().length > 1}>
          <label class="text-fg/60 text-xs font-bold uppercase">Group Name</label>
          <input
            ref={nameInputRef!}
            type="text"
            class="w-full bg-0 rounded-lg text-sm font-medium p-3 outline-none focus:ring-2 ring-accent"
            placeholder={defaultName()}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </Show>
        <div class="flex justify-end gap-2 mt-4">
          <button type="button" class="btn btn-ghost" onClick={() => hideModal()}>
            Cancel
          </button>
          <button type="submit" disabled={isCreating() || !selected().length} class="btn btn-primary">
            {selected().length === 0 ? 'Start Conversation' : selected().length === 1 ? 'Open DM' : 'Create Group'}
          </button>
        </div>
      </form>
    </ModalTemplate>
  )
}
