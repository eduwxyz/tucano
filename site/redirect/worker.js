// Sends every other Tucano domain to tucano.sh, keeping the path and query,
// so search engines count them as one site.
export default {
  fetch(request) {
    const { pathname, search } = new URL(request.url)
    return Response.redirect(`https://tucano.sh${pathname}${search}`, 301)
  },
}
