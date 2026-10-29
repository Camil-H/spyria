let frameToken = ''
const navigate = (url) => parent.postMessage({ navigate: url, token: frameToken }, '*')
const pageAddressOf = (url) => url.split('#')[0]
let shownAddress = ''

const followLink = (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || !/^https?:/i.test(link.href)) return
  event.preventDefault()
  const { hash } = new URL(link.href)
  if (hash && pageAddressOf(link.href) === pageAddressOf(shownAddress))
    return document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView()
  navigate(link.href)
}

const submitForm = (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  event.preventDefault()
  const action = new URL(event.submitter?.getAttribute('formaction') || form.action, document.baseURI)
  if ((event.submitter?.getAttribute('formmethod') || form.method).toLowerCase() !== 'get')
    return window.open(action.href, '_blank', 'noopener')
  action.search = new URLSearchParams(new FormData(form, event.submitter)).toString()
  navigate(action.href)
}

const followRefresh = () => {
  const refresh = document.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content') ?? ''
  const target = /url\s*=\s*['"]?([^'"]+)/i.exec(refresh)?.[1]
  if (target) navigate(new URL(target.trim(), document.baseURI).href)
}

addEventListener('message', (event) => {
  if (event.source !== parent || typeof event.data?.html !== 'string') return
  shownAddress = String(event.data.url ?? '')
  frameToken = String(event.data.token ?? '')
  document.open()
  document.write(event.data.html)
  document.close()
  document.addEventListener('click', followLink, true)
  document.addEventListener('submit', submitForm, true)
  followRefresh()
})
