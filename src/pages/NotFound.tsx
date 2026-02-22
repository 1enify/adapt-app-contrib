import Icon from "../components/icons/Icon";
import Hand from "../components/icons/svg/Hand";
import Header from "../components/ui/Header";
import {t} from "../i18n";

export default function NotFound() {
  return (
    <div class="flex flex-col items-center justify-center w-full h-full">
      <Header>{t('not_found.header')}</Header>
      <Icon icon={Hand} class="fill-fg w-24 h-24 mb-4" />
      <p class="font-title font-medium text-4xl">{t('not_found.header')}</p>
      <a class="btn btn-sm text-lg mt-4" onClick={() => window.history.back()}>
        {t('not_found.go_back')}
      </a>
    </div>
  )
}
