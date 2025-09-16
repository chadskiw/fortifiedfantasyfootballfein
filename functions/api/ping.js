export async function onRequestGet() {
  return new Response("pong", { status: 200, headers: { "x-ff-func": "hit" } });
}
