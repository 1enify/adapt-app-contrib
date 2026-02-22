import {ModalId, ModalTemplate, useModal} from "../ui/Modal";
import {createSignal, type JSX, Match, type ParentProps, Setter, Show, Switch} from "solid-js";
import {getApi} from "../../api/Api";
import type {Guild, Member} from "../../types/guild";
import {useNavigate} from "@solidjs/router";
import {snowflakes} from "../../utils";
import {GuildCreateEvent} from "../../types/ws";
import Icon, {IconElement} from "../icons/Icon";
import ChevronRight from "../icons/svg/ChevronRight";
import ChevronLeft from "../icons/svg/ChevronLeft";
import RocketLaunch from "../icons/svg/RocketLaunch";
import ContextMenu, {ContextMenuButton} from "../ui/ContextMenu";
import UserPlus from "../icons/svg/UserPlus";
import {t} from "../../i18n";

export enum ModalPage { New, Create, Join }

interface Props {
  setPage: Setter<ModalPage>
}

function Card({ title, children, ...props }: ParentProps<{ title: string }> & JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      class="flex justify-between gap-2 border-2 border-bg-3 rounded-lg p-4 w-full hover:bg-0
        transition-colors cursor-pointer items-center mt-2"
      {...props}
    > {/* TODO */}
      <div>
        <h3 class="text-left font-medium font-title text-lg">{title}</h3>
        <p class="text-sm text-left">{children}</p>
      </div>
      <Icon icon={ChevronRight} title="Click to go" class="fill-fg select-none w-4 h-4"/>
    </button>
  )
}

interface ExtendedProps extends Props {
  title: string,
  placeholder: string,
  onSubmit: (name: string, nonce: string, acker: (guildId: bigint) => void) => Promise<string | void>,
  buttonIcon?: IconElement,
  buttonLabel: string,
  minLength: number,
  maxLength: number,
}

function Base(props: ParentProps<ExtendedProps>) {
  const api = getApi()!
  const navigate = useNavigate()
  const {hideModal} = useModal()

  const [error, setError] = createSignal<string>()
  let input: HTMLInputElement | null = null
  let submit: HTMLButtonElement | null = null

  return (
    <ModalTemplate title={props.title}>
      {props.children}
      <form
        class="flex flex-wrap gap-4"
        onSubmit={async (event) => {
          event.preventDefault()

          const name = input!.value
          submit!.disabled = true

          let acked = false
          let ack = (guildId: bigint) => {
            acked = true
            hideModal()
            navigate(`/guilds/${guildId}`)
          }

          const nonce = snowflakes.fromTimestamp(Date.now())
          api.ws?.on("guild_create", (event: GuildCreateEvent, remove) => {
            if (acked)
              return remove()
            if (!event.nonce || event.nonce != nonce.toString())
              return

            ack(event.guild.id)
            remove()
          })

          const error = await props.onSubmit(name, nonce.toString(), ack)
          if (error) {
            submit!.disabled = false
            setError(error)
          }
        }}
      >
        <input
          ref={input!}
          name="name"
          type="text"
          class="w-full bg-0 rounded-lg text-sm font-medium p-3 mt-4 outline-none focus:ring-2 ring-accent"
          placeholder={props.placeholder}
          minLength={props.minLength}
          maxLength={props.maxLength}
          required
        />
        <Show when={error()} keyed={false}>
          <div class="w-full text-danger rounded-lg p-1">
            {error()}
          </div>
        </Show>
        {/* If a button component was used, some browsers will not recognize the button after it. */}
        <div class="flex gap-x-2 btn btn-neutral" onClick={() => props.setPage(ModalPage.New)}>
          <Icon icon={ChevronLeft} class="fill-neutral-content/60 select-none w-4 h-4" />
          Back
        </div>
        <button
          ref={submit!}
          type="submit"
          class="btn btn-primary flex-grow disabled:bg-accent/50 disabled:text-opacity-50"
        >
          {props.buttonIcon && <Icon icon={props.buttonIcon} class="fill-fg w-4 h-4 mr-2" />}
          <span>{props.buttonLabel}</span>
        </button>
      </form>
    </ModalTemplate>
  )
}

function NewGuild(props: Props) {
  const navigate = useNavigate()
  const {hideModal} = useModal()
  return (
    <ModalTemplate title={t('modals.new_guild.title')}>
      <div class="flex flex-col pt-2">
        <Card title={t('modals.new_guild.create_server.label')} onClick={() => props.setPage(ModalPage.Create)}>
          {t('modals.new_guild.create_server.description')}
        </Card>
        <Card title={t('modals.new_guild.join_server.label')} onClick={() => props.setPage(ModalPage.Join)}>
          {t('modals.new_guild.join_server.description')}
        </Card>
        <Card title={t('modals.new_guild.discover_servers.label')} onClick={() => {
          navigate('/discover')
          hideModal()
        }}>
          {t('modals.new_guild.discover_servers.description')}
        </Card>
      </div>
    </ModalTemplate>
  )
}

export function NewGuildModal(srcProps: { pageSignal?: ModalPage }) {
  const [page, setPage] = createSignal(srcProps.pageSignal ?? ModalPage.New)
  const props = { setPage }
  const api = getApi()!

  return (
    <Switch>
      <Match when={page() == ModalPage.New} keyed={false}>
        <NewGuild {...props} />
      </Match>
      <Match when={page() == ModalPage.Create} keyed={false}>
        <Base
          {...props}
          title={t('modals.create_server.title')}
          placeholder={`${api.cache!.clientUser?.username}'s server`}
          onSubmit={async (name, nonce) => {
            const response = await api.request<Guild>('POST', '/guilds', { json: { name, nonce } })
            if (!response.ok)
              return response.errorJsonOrThrow().message
          }}
          buttonIcon={RocketLaunch}
          buttonLabel={t('modals.create_server.submit')}
          minLength={2}
          maxLength={50}
        >
          <p class="flex flex-col text-fg/70 text-center text-sm mt-2 mx-2">
            <span>{t('modals.create_server.description')}</span>
            <span class="text-fg/50">{t('modals.create_server.description_note')}</span>
          </p>
        </Base>
      </Match>
      <Match when={page() == ModalPage.Join} keyed={false}>
        <Base
          {...props}
          title={t('modals.join_server.title')}
          placeholder={t('modals.join_server.placeholder')}
          onSubmit={async (code, nonce, acker) => {
            const matches = code.match(/(?:(?:https?:\/\/(?:www\.)?)?adapt\.chat\/invite\/)?(\w{6,12})\/?/) ?? code
            if (!matches || matches.length < 1)
              return t('modals.join_server.invalid_code')

            const response = await api.request<Member>('POST', `/invites/${matches[1]}`, { params: { nonce } })
            if (!response.ok)
              return response.errorJsonOrThrow().message

            const { guild_id } = response.ensureOk().jsonOrThrow()
            if (api.cache?.guildList?.includes(guild_id))
              acker(guild_id)
          }}
          buttonLabel="Join Server"
          minLength={6}
          maxLength={38}
        >
          <div class="mt-2 mx-2 text-fg/70">
            <span class="block text-center">{t('modals.join_server.description')}</span>
            <h2 class="font-bold mt-2 text-sm">{t('modals.join_server.examples_header')}</h2>
            <ul class="text-sm list-disc pl-4">
              <li>https://adapt.chat/invite/Dv6a7c2t</li>
              <li>adapt.chat/invite/Dv6a7c2t</li>
              <li>Dv6a7c2t</li>
            </ul>
          </div>
        </Base>
      </Match>
    </Switch>
  )
}

export function NewGuildModalContextMenu() {
  const {showModal} = useModal()
  return (
    <ContextMenu>
      <ContextMenuButton
        icon={RocketLaunch}
        label={t('modals.create_server.submit')}
        buttonClass="hover:bg-accent"
        onClick={() => showModal(ModalId.NewGuild, ModalPage.Create)}
      />
      <ContextMenuButton
        icon={UserPlus}
        label={t('modals.join_server.submit')}
        onClick={() => showModal(ModalId.NewGuild, ModalPage.Join)}
      />
    </ContextMenu>
  )
}