import { supabase } from './supabase';

function extFromMime(mime) {
  if (mime && mime.includes('png')) return 'png';
  if (mime && mime.includes('webp')) return 'webp';
  return 'jpg';
}

export async function uploadActivityPhoto(userId, activityId, localUri) {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const path = `${activityId}/${userId}-${Date.now()}.${extFromMime(blob.type)}`;

  const { error: uploadError } = await supabase.storage
    .from('activity-photos')
    .upload(path, blob, { contentType: blob.type || 'image/jpeg' });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from('activity-photos').getPublicUrl(path);

  const { error: insertError } = await supabase
    .from('activity_images')
    .insert({ activity_id: activityId, url: data.publicUrl, uploaded_by: userId, status: 'pending' });
  if (insertError) throw insertError;

  return data.publicUrl;
}
