import { ModalTemplate, useModal } from "../ui/Modal";
import { getApi } from "../../api/Api";
import { createMemo, createSignal, onMount } from "solid-js";
import { t, tJsx } from "../../i18n";

export default function EditNicknameModal(props: { guildId: bigint, memberId: bigint, current: string }) {
  const api = getApi()!;
  const cache = api.cache!;
  const { hideModal } = useModal();

  const user = createMemo(() => cache.users.get(props.memberId)!);
  const guild = createMemo(() => cache.guilds.get(props.guildId)!);

  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const save = async (e: SubmitEvent) => {
    e.preventDefault()
    const nick = input?.value ?? props.current;
    if (nick === props.current) return hideModal();

    setIsSubmitting(true)
    try {    
      const json = { nick: nick.trim() || null };
      const me = cache.clientId === props.memberId;
      const endpoint = me
        ? `/guilds/${props.guildId}/members/me`
        : `/guilds/${props.guildId}/members/${props.memberId}`;
      const resp = await api.request('PATCH', endpoint as any, { json });
      if (!resp.ok) throw new Error(resp.errorJsonOrThrow().message);
      hideModal();
    } finally {
      setIsSubmitting(false)
    }
  }

  let input: HTMLInputElement | null = null;
  onMount(() => setTimeout(() => input!.focus(), 200));

  return (
    <ModalTemplate title={t('modals.edit_nickname.title')}>
      <p class="block font-light text-sm text-fg/60 text-center mt-4">
        {tJsx('modals.edit_nickname.description', {
          username: <b>{user().username}</b>,
          guild: <b>{guild().name}</b>
        })}
        <br />
        {t('modals.edit_nickname.visible_note')}
      </p>
      <form onSubmit={save}>
        <input
          ref={input!}
          type="text"
          class="w-full bg-0 rounded-lg text-sm font-medium p-3 mt-4 outline-none focus:ring-2 ring-accent"
          placeholder={t('modals.edit_nickname.placeholder')}
          value={props.current}
          required
        />
        <div class="flex justify-end gap-2 mt-4">
          <button class="btn btn-ghost" type="button" onClick={() => hideModal()}>
            {t('generic.cancel')}
          </button>
          <button class="btn btn-primary" type="submit" disabled={isSubmitting()}>
            {t('generic.save')}
          </button>
        </div>
      </form>
    </ModalTemplate>
  )
}
