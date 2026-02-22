import {ModalTemplate, useModal} from "../ui/Modal";
import {createSignal, Show} from "solid-js";
import {useNavigate} from "@solidjs/router";
import {getApi} from "../../api/Api";
import type {Props} from "./ConfirmGuildLeaveModal"
import Trash from "../icons/svg/Trash";
import Icon from "../icons/Icon";
import {t, tJsx} from "../../i18n";

export default function ConfirmGuildDeleteModal(props: Props) {
  const [confirmGuildLeaveModalError, setConfirmGuildLeaveModalError] = createSignal<string>()
  const [guildNameIsCorrect, setGuildNameIsCorrect] = createSignal<boolean>(false)
  const {hideModal} = useModal()

  const api = getApi()!
  const navigate = useNavigate()

  let guildNameInput: HTMLInputElement | null = null
  let passwordInput: HTMLInputElement | null = null
  let submitButton: HTMLButtonElement | null = null

  return (
    <ModalTemplate title={t('modals.delete_server.title')}>
      <p class="text-fg/70 text-center text-sm mt-4">
        {tJsx('modals.delete_server.description', { name: <b>{props.guild.name}</b> })}
      </p>
      <form
        class="flex flex-wrap justify-end"
        onSubmit={async (event) => {
          event.preventDefault()
          if ((guildNameInput as any)?.value !== props.guild.name)
            setConfirmGuildLeaveModalError(t('modals.delete_server.name_mismatch'))

          submitButton!.disabled = true

          let response
          try {
            response = await api.request('DELETE', `/guilds/${props.guild.id}`, {
              json: {
                password: (passwordInput as any)?.value,
              },
            })
          } finally {
            submitButton!.disabled = false
          }
          if (!response.ok) {
            setConfirmGuildLeaveModalError(response.errorJsonOrThrow().message)
            return
          }

          hideModal()
          navigate('/')
        }}
      >
        <div class="w-full">
          <label
            class="flex flex-col mt-4 pl-1 text-sm font-medium text-fg/60 "
            for="guild-name"
          >
            {t('modals.delete_server.name_label')}
          </label>
          <input
            class="input outline-none w-full bg-0 mt-2 focus:outline-none focus:ring-2 focus:ring-accent"
            ref={guildNameInput!}
            id="guild-name"
            name="guild-name"
            type="text"
            autocomplete="off"
            placeholder={props.guild.name}
            required
            onInput={(event) => {
              setGuildNameIsCorrect(event.currentTarget.value === props.guild.name)
            }}
          />
        </div>
        <div class="w-full">
          <label
            class="flex flex-col mt-4 pl-1 text-sm font-medium text-fg/60 w-full"
            for="password"
          >
            {t('modals.delete_server.password_label')}
          </label>
          <input
            class="input outline-none w-full bg-0 mt-2 focus:outline-none focus:ring-2 focus:ring-accent"
            ref={passwordInput!}
            id="password"
            name="password"
            type="text"
            placeholder={t('modals.delete_server.password_placeholder')}
            minLength={6}
            required
            onKeyUp={(event) => {
              event.currentTarget.type = event.currentTarget.value == null ? 'text' : 'password'
            }}
          />
        </div>
        <Show when={confirmGuildLeaveModalError()} keyed={false}>
          <p class="text-danger mt-4 w-full">{confirmGuildLeaveModalError()}</p>
        </Show>
        {/* Use a div to prevent it being treated as the target when pressing enter */}
        <div class="btn border-none btn-ghost mt-4" onClick={() => hideModal()}>
          {t('generic.cancel')}
        </div>
        <button
          ref={submitButton!}
          type="submit"
          class="btn btn-danger border-none mt-4 ml-4"
          disabled={!guildNameIsCorrect()}
        >
          <Icon icon={Trash} class="fill-fg w-4 h-4 mr-2" />
          {t('modals.delete_server.title')}
        </button>
      </form>
    </ModalTemplate>
  )
}