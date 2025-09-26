async function uploadAvatar(file) {
  try {
    // 1) presign
    const p = await jfetch('/api/images/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content_type: file.type })
    });
    if (!p?.ok) throw new Error('presign_failed');

    // 2) PUT to R2
    const put = await fetch(p.url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file
    });
    if (!put.ok) throw new Error(`upload_failed_${put.status}`);

    // 3) now persist the key in quickhitter
    await jfetch('/api/quickhitter/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ image_key: p.key })
    });

    // 4) update ff.pre.signup so UI shows the avatar and Next
    writePre({ ...readPre(), image_key: p.key });
    paintMiniAvatar();
  } catch (e) {
    console.warn('[avatar upload] Error:', e.message || e);
  }
}

// trigger
document.querySelector('#hiddenFile')?.addEventListener('change', (ev) => {
  const f = ev.target.files?.[0];
  if (f) uploadAvatar(f);
});
