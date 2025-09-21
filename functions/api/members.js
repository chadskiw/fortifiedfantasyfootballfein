async function listMembersHandler(req, res) { /* existing code */ }
app.get('/api/members', listMembersHandler);
app.get('/api/identity/members', listMembersHandler);
