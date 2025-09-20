CHECK THIS OUT
// TRUE_LOCATION: public/controls/enums.js
// IN_USE: FALSE
// /public/controls/enums.js
// NOTE: served as an ES module with Content-Type: application/javascript

/* ====== Obfuscation helpers (client fallback) ======
   This is deterrence, not real security. If you can put this on the server,
   do so — otherwise this keeps raw IDs out of casual page scrape output.
*/
const PERM_BANK = [
  [0,3,5,2,1,7,4,6],
  [6,1,4,7,2,5,3,0],
  [2,0,7,1,5,3,6,4],
  [5,4,0,6,3,1,7,2],
  [1,7,2,3,6,0,5,4],
  [4,6,1,0,7,2,5,3],
];

function _permuteDigits(digits, bankRowIdx) {
  const p = PERM_BANK[bankRowIdx % PERM_BANK.length];
  const out = new Array(digits.length);
  for (let i = 0; i < digits.length; i++) {
    const j = p[i % p.length];
    out[i] = digits[j % digits.length];
  }
  return out;
}
function _digitsOnly(s) { return String(s || '').replace(/\D+/g, ''); }
function _padLeft(s, len, ch='0'){ s=String(s); while(s.length<len) s=ch+s; return s; }
function _checksum(s) { // tiny checksum (0..255)
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + (s.charCodeAt(i) * 131)) & 0xff;
  return h;
}

/** Obfuscate a numeric-ish id to a token */
function obfuscateId(rawId) {
  const base = _digitsOnly(rawId);
  if (!base) return '';
  const ck = _checksum(base);             // 0..255
  const row = ck % PERM_BANK.length;
  const digits = base.split('');
  const perm = _permuteDigits(digits, row).join('');
  // token: <rowHex>-<perm>-<ckHex>
  return `${row.toString(16)}-${perm}-${_padLeft(ck.toString(16), 2)}`;
}

/** Recover the original id from token */
export function reveal(token) {
  if (!token || typeof token !== 'string') return '';
  const [rowHex, perm, ckHex] = token.split('-');
  const row = parseInt(rowHex, 16);
  if (!perm || Number.isNaN(row)) return '';
  // reverse permutation: we search which digits landed where
  const p = PERM_BANK[row % PERM_BANK.length];
  const out = new Array(perm.length);
  for (let i = 0; i < perm.length; i++) {
    const j = p[i % p.length] % perm.length;
    out[j] = perm[i];
  }
  const candidate = out.join('');
  // optional: sanity – checksum should match
  const ck = parseInt(ckHex, 16);
  if (!Number.isNaN(ck) && ((_checksum(candidate) & 0xff) !== (ck & 0xff))) {
    // bad token; return empty to be safe
    return '';
  }
  return candidate;
}

/* ====== Your raw enum (ANY of these shapes are accepted) ======
   Replace with your real list. You can keep this file tiny and let CI
   inject content, or fetch server-side and inline during build.
*/
export const FB_GROUP_ENUM = [
  { id: 1, identifier:'2213414128877661', name: 'Fantasy Football', href: 'https://www.facebook.com/groups/2213414128877661', iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-6/503998587_1298666212262907_4921691394937215283_n.jpg?stp=dst-jpg_s720x720_tt6&_nc_cat=1&ccb=1-7&_nc_sid=2285d6&_nc_ohc=-98dBrKnrgwQ7kNvwH3f7by&_nc_oc=Adnd2aU4drlRm0uCKYIVOh_h76XIdGqkqjXzG8dRPsifjE6zl1JtC-m2xOVPTBOO-gs&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=8QsKz8ZjYYp-F-hcwzQDCA&oh=00_AfZb_zJMHQnf59E9SH89OJRgUdmmofT0mh5Ho_chDa6IdA&oe=68D10BCC' },
  { id: 2, identifier: '479438029370708', name: 'Fantasy Football Advice!', href: 'https://www.facebook.com/groups/479438029370708', iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t1.6435-9/80194693_2348161931954369_5079561566467129344_n.jpg?stp=dst-jpg_s720x720_tt6&_nc_cat=1&ccb=1-7&_nc_sid=2285d6&_nc_ohc=KR6N8olAgroQ7kNvwFZOTH6&_nc_oc=AdnIK8sqJ0ATcmg0Q2n_jRoy9jkao8e3jShwJw_PHuC0hbKAi3FjB9TBuPo7cjARVto&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=cW2nApZI_deXZ_C9WX0KgQ&oh=00_AfZvJ4TbOJ_bRMaPXe0Y91OzkoxbiZ4y-GkG022IJrczoQ&oe=68F28EEB' },
  { id: 3, identifier: 'ffadvice420', name: "Fantasy Football Advice - Experts, Guru’s & Beginners", href: 'https://www.facebook.com/groups/ffadvice420', iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-6/494679216_10161504250373002_2355866329849025947_n.png?stp=dst-jpg_s720x720_tt6&_nc_cat=108&ccb=1-7&_nc_sid=2285d6&_nc_ohc=lqYE-Obs6TkQ7kNvwGN43tt&_nc_oc=AdnOXCZGuFcoHp0rMilMIs2-L5VIMcPRA8oS-tk1vJdKyklT17JFvHFdCY8xnUiiVEM&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=O_Sn796vvkNEbgSxmt8FIA&oh=00_AfZ1_Mtf3WBH28L7YNR-P8o6_RmLZF3NNaTIZbhiKO8u7Q&oe=68D105D6' },
  { id: 4, identifier: '1924360977823490', name: `Fantasy Football: Start 'Em/Sit 'Em - the weekly look at NFL players`, href: 'https://www.facebook.com/groups/1924360977823490', iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-6/464387734_2211241372595260_6197229767446856550_n.jpg?stp=dst-jpg_s720x720_tt6&_nc_cat=110&ccb=1-7&_nc_sid=2285d6&_nc_ohc=Kv3z7Ks2zAcQ7kNvwH8dIpH&_nc_oc=Admd1-O1w0qv3e5tylHtCxS6L2mtpeI6xLa7mnz5YsO3ud3Ug-ruLIL9_RRlIiX9-cs&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=7XXdhWHKgmaL6oUlQorPEQ&oh=00_AfZI2N5iXFwEKFAqE6SgGfK4oECJj4zjfd0F3vb7W0Csnw&oe=68D0FE16' },
  { id: 5, identifier: 'NFLTALK32', name: 'Fantasy Football Nation', href: 'https://www.facebook.com/groups/NFLTALK32', iUrl:'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-6/497625153_670387602651829_1019825713441424462_n.jpg?_nc_cat=104&ccb=1-7&_nc_sid=2285d6&_nc_ohc=M8SGOwjOsecQ7kNvwFxFj81&_nc_oc=AdmlDqeeuad4-EhV7x-2uJPMNRzXviWU5EnChlDSRr-ACXNQTpio_rkU4phorvyn274&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=KjZ4EHpvsxsvmulHZDERVw&oh=00_Afa1YzLr2HGL7ww8ELWUmKN5I_lMhINo9gFj0JQi1AjKbw&oe=68D13228' },
  { id: 6, identifier: 'fantasyfootballleaguefinder', name: 'Fantasy Football Advice!', href: 'https://www.facebook.com/groups/fantasyfootballleaguefinder', iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-1/533114056_675265452279535_2646195863653602014_n.jpg?stp=cp0_dst-jpg_s40x40_tt6&_nc_cat=110&ccb=1-7&_nc_sid=e99d92&_nc_ohc=nfMIhoFUKDkQ7kNvwGyYEBw&_nc_oc=AdlA6UQAAl93w9oUK6s8zPHLeRSTInVI9FOeNNlVS98tmyoKsfN3Vk87CyhKvdPClqY&_nc_zt=24&_nc_ht=scontent.fabe1-1.fna&_nc_gid=kOJMInfRvwkGBWIgzN0zyw&oh=00_AfYY4pj9LaC3KL2D69_mG22Ltmgm5Tul9g1_TobpYFOgJw&oe=68D11008' },
  { id: 7, identifier: '124337374374908', name: 'Fantasy Football Discussion', href: 'https://www.facebook.com/groups/124337374374908' , iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-6/499535980_10115816254096863_2595012354328497380_n.png?stp=dst-jpg_s720x720_tt6&_nc_cat=109&ccb=1-7&_nc_sid=2285d6&_nc_ohc=VryZF-8NWAUQ7kNvwHX3YaK&_nc_oc=AdlqlZN_PFVW2EVjdJKWGvJBHWYkV6aVCn_LxWGiZbw26WLWObHUho_Oo9pyjHIsPCQ&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=1eYDk3WmkiTYrwK9pPBZ5g&oh=00_AfY6n8vjXGaEidqwXiWXKQcWeh_guhF-ZtfaOz27g9cuZg&oe=68D1103B'},
  { id: 8, identifier: '1649966738571314', name: 'Fantasy Football Talk', href: 'https://www.facebook.com/groups/1649966738571314' , iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t39.30808-6/472192975_10230640340046900_7595210041516003769_n.jpg?stp=dst-jpg_s720x720_tt6&_nc_cat=111&ccb=1-7&_nc_sid=2285d6&_nc_ohc=P1x4l1aEvWYQ7kNvwF61Mqt&_nc_oc=AdnMWCcgsB1x5y8uXoZcZzFRD7Dk9Rx1YSUUcx_6zDTuqiNvxKmD_HGtUaeSZu_-vFk&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=gY6f1CB6dIzDBE8mYo8Jmg&oh=00_AfYMMkHDfw3ZthICuCk-mI3ejpMVDGxBPZiR3MHmzrKKsw&oe=68D0F7C2'},
  { id: 9, identifier: '998285613949875', name: 'Fantasy Football League Finder', href: 'https://www.facebook.com/groups/998285613949875' , iUrl: 'https://scontent.fabe1-1.fna.fbcdn.net/v/t1.6435-9/107393395_3201155589950620_2855361511087118186_n.jpg?stp=dst-jpg_s720x720_tt6&_nc_cat=105&ccb=1-7&_nc_sid=2285d6&_nc_ohc=thnFl9Xs0awQ7kNvwEbMeVj&_nc_oc=AdkhrwuuqDTUwlsVm2U05OEyaZLnjw_rWX42c76N4IzD0kbstMDUcBInvkTPgUoLv3s&_nc_zt=23&_nc_ht=scontent.fabe1-1.fna&_nc_gid=YwRCfv5tnUgKCSIlDq3tAw&oh=00_AfayYiw4T1uBtRxjb4B4jVsIoDy6HWd8E4F1nmDgOFHehw&oe=68F298C1'},
];




/* ====== Normalized export for the UI ====== */
export const FB_GROUPS = (FB_GROUP_ENUM ?? []).map((g) => {
  if (typeof g === 'string') {
    return { token: obfuscateId(g), name: g, link: null };
  }
  const id   = g.id   ?? g.value ?? g.slug  ?? String(g.name ?? g.label ?? '');
  const name = g.name ?? g.label ?? String(g.id ?? g.value ?? g.slug ?? '');
  const link = g.link ?? g.url   ?? null;
  return { token: obfuscateId(id), name, link };
});
