import { supabase } from './supabase';

const ARCHIVE_ENTITY_TYPES = new Set(['פעילות']);
const ARCHIVE_CATEGORIES = new Set(['חוג', 'קייטנה']);

function shouldArchiveForCommitment(activity) {
  return ARCHIVE_ENTITY_TYPES.has(activity.entity_type) || ARCHIVE_CATEGORIES.has(activity.category);
}

// שומרת פעילות שמשתמש קצה שלח (בעצמו, לא כלי הייבוא) - תמיד ממתינה לאישור אדמין,
// חוץ ממקרה שהיא נכנסת לקטגוריה שהאפליקציה לא מציגה בכלל (חוג/קייטנה) ואז היא נשמרת בארכיון ישירות.
export async function submitUserActivity(userId, sourceUrl, activity) {
  if (!activity?.name || !activity?.entity_type) {
    throw new Error('חסרים שדות חובה (שם, סוג)');
  }
  const archived = shouldArchiveForCommitment(activity);

  let locationId = null;
  if (activity.location_name) {
    const { data: existing, error: findErr } = await supabase
      .from('locations')
      .select('id, city, region')
      .ilike('name', activity.location_name)
      .limit(1)
      .maybeSingle();
    if (findErr) throw findErr;
    if (existing) {
      locationId = existing.id;
      const fillIn = {};
      if (!existing.city && activity.city) fillIn.city = activity.city;
      if (!existing.region && activity.region) fillIn.region = activity.region;
      if (Object.keys(fillIn).length > 0) {
        const { error: updErr } = await supabase.from('locations').update(fillIn).eq('id', locationId);
        if (updErr) throw updErr;
      }
    } else {
      const { data: created, error: locErr } = await supabase
        .from('locations')
        .insert({ name: activity.location_name, city: activity.city || null, region: activity.region || null })
        .select('id')
        .single();
      if (locErr) throw locErr;
      locationId = created.id;
    }
  }

  const { data: savedActivity, error: actErr } = await supabase
    .from('activities')
    .insert({
      name: activity.name,
      description: activity.description || null,
      entity_type: activity.entity_type,
      location_id: locationId,
      location_detail: activity.location_detail || null,
      min_age: activity.min_age ?? null,
      max_age: activity.max_age ?? null,
      price_type: activity.price_type || null,
      price_amount: activity.price_amount ?? null,
      category: activity.category || null,
      duration_minutes: activity.duration_minutes ?? null,
      indoor_outdoor: activity.indoor_outdoor || null,
      booking_requirement: activity.booking_requirement || null,
      weather_suitable: activity.weather_suitable || [],
      amenities: activity.amenities || [],
      family_fit: activity.family_fit || [],
      status: archived ? 'archived' : 'pending',
      source: 'user_submitted',
      source_url: sourceUrl || null,
      created_by: userId,
    })
    .select('id')
    .single();
  if (actErr) throw actErr;

  const scheduleRows = [];
  if (activity.schedule_type === 'recurring' && Array.isArray(activity.recurring_days) && activity.recurring_days.length) {
    for (const day of activity.recurring_days) {
      scheduleRows.push({
        activity_id: savedActivity.id,
        schedule_type: 'recurring',
        day_of_week: day,
        start_time: activity.start_time || null,
        end_time: activity.end_time || null,
      });
    }
  } else if (activity.schedule_type === 'one_time') {
    scheduleRows.push({
      activity_id: savedActivity.id,
      schedule_type: 'one_time',
      one_time_date: activity.one_time_date || null,
      start_time: activity.start_time || null,
      end_time: activity.end_time || null,
    });
  } else if (activity.schedule_type === 'fixed_hours') {
    scheduleRows.push({
      activity_id: savedActivity.id,
      schedule_type: 'fixed_hours',
      start_time: activity.start_time || null,
      end_time: activity.end_time || null,
    });
  }
  if (scheduleRows.length) {
    const { error: schedErr } = await supabase.from('activity_schedules').insert(scheduleRows);
    if (schedErr) throw schedErr;
  }

  if (Array.isArray(activity.image_urls) && activity.image_urls.length) {
    const imageRows = activity.image_urls
      .filter((url) => typeof url === 'string' && url.trim())
      .slice(0, 3)
      .map((url) => ({ activity_id: savedActivity.id, url, uploaded_by: userId, status: 'pending' }));
    if (imageRows.length) {
      const { error: imgErr } = await supabase.from('activity_images').insert(imageRows);
      if (imgErr) throw imgErr;
    }
  }

  return { activityId: savedActivity.id, archived };
}

export async function extractActivityFromUrl(url) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('צריך להתחבר קודם');
  const { data, error } = await supabase.functions.invoke('extract-activity', { body: { url } });
  if (error) {
    // FunctionsHttpError נותן הודעה גנרית - הפרטים האמיתיים יושבים בגוף התשובה עצמו
    if (error.context && typeof error.context.json === 'function') {
      try {
        const body = await error.context.json();
        if (body?.error) throw new Error(body.error);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
