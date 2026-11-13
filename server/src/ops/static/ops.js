// Progressive enhancement only: every page works without this file.
document.addEventListener('click', function (event) {
  var button = event.target.closest('[data-copy]');
  if (!button) return;
  var source = document.getElementById(button.getAttribute('data-copy'));
  if (!source || !navigator.clipboard) return;
  navigator.clipboard.writeText(source.textContent.trim()).then(function () {
    button.textContent = 'Copied';
  });
});
// An activation link carries its code after "#", which browsers never send to a server.
var field = document.querySelector('[data-from-fragment]');
var match = /code=([A-Za-z0-9-]+)/.exec(location.hash);
if (field && match) {
  field.value = match[1];
  history.replaceState(null, '', location.pathname);
}
