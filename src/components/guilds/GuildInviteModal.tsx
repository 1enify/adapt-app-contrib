import type {Guild} from "../../types/guild";
import {getApi} from "../../api/Api";
import {createEffect, createSignal} from "solid-js";
import {ModalId, ModalTemplate, useModal} from "../ui/Modal";
import Check from "../icons/svg/Check";
import Icon from "../icons/Icon";
import ClipboardIcon from "../icons/svg/Clipboard";
import {t, tJsx} from "../../i18n";

export default function GuildInviteModal(props: { guild: Guild }) {
  let inputRef: HTMLInputElement | null = null
  const modal = useModal()

  const api = getApi()!
  const [code, setCode] = createSignal<string>()
  const [copied, setCopied] = createSignal(false)

  createEffect(async () => {
    if (modal.id != ModalId.CreateInvite) return

    const code = api.cache!.inviteCodes.get(props.guild.id)
    if (code) {
      setCode(code)
      return
    }

    const response = await api.request('POST', `/guilds/${props.guild.id}/invites`, {
      json: {},
    })
    const { code: inviteCode } = response.ensureOk().jsonOrThrow()

    api.cache!.inviteCodes.set(props.guild.id, inviteCode)
    setCode(inviteCode)
  })

  return (
    <ModalTemplate title={t('modals.invite_people.title')}>
      <p class="text-fg/70 text-center mt-2">
        {tJsx('modals.invite_people.description', {
          name: <b>{props.guild.name}</b>
        })}
      </p>
      <div class="flex items-center justify-between bg-0 mt-4 rounded-lg box-border overflow-hidden">
        <input
          ref={inputRef!}
          type="text"
          class="bg-transparent p-2 text-fg flex-grow outline-none focus:text-accent-light transition"
          value={code() ? `https://adapt.chat/invite/${code()}` : t('generic.loading')}
          readonly
        />
        <button
          classList={{
            "flex items-center justify-center transition-all duration-200 p-2 w-10 h-10": true,
            "bg-3 hover:bg-accent": !copied(),
            "bg-success": copied(),
          }}
          onClick={async () => {
            await navigator.clipboard.writeText(inputRef!.value)

            setCopied(true)
            setTimeout(() => setCopied(false), 1000)
          }}
        >
          <Icon
            icon={copied() ? Check : ClipboardIcon}
            title={t('generic.copy_to_clipboard')}
            class="w-4 h-4 fill-fg"
          />
        </button>
      </div>
    </ModalTemplate>
  )
}
