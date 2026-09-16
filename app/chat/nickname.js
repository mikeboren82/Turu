import PlaceholderScreen from '../../components/PlaceholderScreen';
import { useI18n } from '../../lib/i18n';

export default function GuestNicknameScreen() {
  const { t } = useI18n();
  return <PlaceholderScreen title={t('nav.chat.nickname')} />;
}
