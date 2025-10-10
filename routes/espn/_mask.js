// routes/espn/_mask.js
exports.mask = function mask(token = '', left = 6, right = 4) {
  if (!token) return '';
  if (token.length <= left + right) return token[0] + '…' + token.slice(-1);
  return token.slice(0, left) + '…' + token.slice(-right);
};
