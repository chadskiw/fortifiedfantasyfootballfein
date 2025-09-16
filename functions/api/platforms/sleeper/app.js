async function showSleeperTeamNow(leagueId, teamId) {
  const wrap = document.getElementById('rosterWrap') || document.body;
  wrap.innerHTML = `<div class="card-body muted">Loading Sleeper roster…</div>`;

  const res = await fetch(`/api/platforms/sleeper/league/${encodeURIComponent(leagueId)}/rosters?season=2025&include=players`);
  if (!res.ok) { wrap.innerHTML = `<div class="card-body error">Fetch failed: ${res.status}</div>`; return; }
  const j = await res.json();

  const t = (j.teams || []).find(x => String(x.teamId) === String(teamId));
  if (!t) { wrap.innerHTML = `<div class="card-body error">Team ${teamId} not found.</div>`; return; }

  const rows = (t.roster?.players || []).map(p => `
    <tr>
      <td>
        <div class="pp-starter">
          <img src="${p.headshotUrl || ''}" alt="" style="height:28px;width:28px;border-radius:50%;object-fit:cover;margin-right:8px;vertical-align:middle">
          <span class="pp-name">${p.name}</span>
          <div class="pp-sub muted">${p.pos}</div>
        </div>
      </td>
      <td>${p.nflTeam || '—'}</td>
      <td>${p.lineupSlotId ?? '—'}</td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <div class="card-body">
      <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:8px">
        <h3 style="margin:0">${t.teamName}</h3>
        <div class="muted">RosterId: ${t.teamId}</div>
      </div>
      <table>
        <thead><tr><th>Player</th><th>NFL</th><th>SlotId</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}
