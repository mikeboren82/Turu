import { WHEN_OPTIONS } from '../constants/filterSchema';
import { t, listJoin, formatDate } from './i18n';
import { categoriesSummary } from './i18n/format';

// Natural "a, b and c" list in the active locale.
export { listJoin };

export function categorySummary(selectedIds) {
  return categoriesSummary(selectedIds);
}

export function whenSummary(when) {
  const options = when?.options || [];
  if (options.length === 0) return t('domain.summary.now');
  const labels = options.map((id) => (
    id === 'specific' && when.date
      ? formatDate(when.date)
      : WHEN_OPTIONS.find((o) => o.id === id)?.label ?? id
  ));
  if (labels.length <= 3) return listJoin(labels);
  return t('domain.summary.whenOptions', { count: labels.length });
}
