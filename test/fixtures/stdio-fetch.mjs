// A real stdio child process exercises environment loading and API headers without contacting a service or reading credentials.
globalThis.fetch = async (url, options) => {
  const request = new URL(url);
  if (!request.pathname.endsWith("/getPostFull")) throw new Error("Unexpected endpoint in the isolated stdio fixture");
  return new Response(JSON.stringify({ retcode: 0, data: { post: { post: {
    post_id: request.searchParams.get("post_id"), subject: "Transport fixture", content: "<p>STDIO-FIXTURE-BODY</p>",
    lang: options.headers["x-rpc-language"]
  } } } }));
};
