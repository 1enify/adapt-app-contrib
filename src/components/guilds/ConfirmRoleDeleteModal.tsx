import {ModalTemplate, useModal} from "../ui/Modal";
import {createMemo, createSignal} from "solid-js";
import {getApi} from "../../api/Api";
import {useNavigate, useParams} from "@solidjs/router";
import Icon from "../icons/Icon";
import Trash from "../icons/svg/Trash";
import {Role} from "../../types/guild";
import {snowflakes} from "../../utils";
import {t, tJsx} from "../../i18n";

type Props = {
  role: Role,
}

export default function ConfirmRoleDeleteModal(props: Props) {
  const api = getApi()!
  const navigate = useNavigate()
  const params = useParams()
  const {hideModal} = useModal()

  const guild = createMemo(() => api.cache!.guilds.get(props.role.guild_id))
  const [isDeleting, setIsDeleting] = createSignal<boolean>(false)

  return (
    <ModalTemplate title={t('modals.delete_role.title')}>
      <p class="text-fg/70 text-center text-sm mt-4">
        {tJsx('modals.delete_role.description', {
          role_name: <b>{props.role.name}</b>,
          guild_name: guild()?.name
        })}
      </p>
      <form
        class="flex flex-wrap justify-end mt-4 gap-x-4"
        onSubmit={async (event) => {
          event.preventDefault()
          setIsDeleting(true)
          try {
            await api.request('DELETE', `/guilds/${props.role.guild_id}/roles/${props.role.id}`)
          } catch (err) {
            setIsDeleting(false)
            throw err
          }
          setIsDeleting(false)
          hideModal()

          const defaultRole = snowflakes.withModelType(props.role.guild_id, snowflakes.ModelType.Role)
          if (params.roleId && BigInt(params.roleId) === props.role.id)
            navigate(`/guilds/${params.guildId}/settings/roles/${defaultRole}`)
        }}
      >
        <button class="btn border-none btn-ghost" onClick={hideModal}>
          {t('generic.cancel')}
        </button>
        <button type="submit" class="btn btn-danger border-none" disabled={isDeleting()}>
          <Icon icon={Trash} class="fill-fg w-4 h-4 mr-2" />
          {t('modals.delete_role.title')}
        </button>
      </form>
    </ModalTemplate>
  )
}
