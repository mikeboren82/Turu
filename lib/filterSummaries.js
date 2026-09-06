import { CATEGORY_OPTIONS, WHEN_OPTIONS } from '../constants/filterSchema';

export function hebrewJoin(labels) {
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} ו${labels[labels.length - 1]}`;
}

export function categorySummary(selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return 'הכל';
  if (selectedIds.length <= 3) return hebrewJoin(selectedIds);
  return `${selectedIds.length} קטגוריות`;
}

export function whenSummary(when) {
  const options = when?.options || [];
  if (options.length === 0) return 'עכשיו';
  const labels = options.map((id) => (
    id === 'specific' && when.date
      ? new Date(when.date).toLocaleDateString('he-IL')
      : WHEN_OPTIONS.find((o) => o.id === id)?.label ?? id
  ));
  if (labels.length <= 3) return hebrewJoin(labels);
  return `${labels.length} אפשרויות זמן`;
}
