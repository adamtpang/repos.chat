document.documentElement.classList.add('js');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const toast = document.querySelector('.toast');
let toastTimer;

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const label = button.querySelector('.copy-label');
    try {
      await copyText(button.dataset.copy);
      if (label) label.textContent = 'Copied';
      showToast('Install command copied');
      window.setTimeout(() => {
        if (label) label.textContent = 'Copy';
      }, 1800);
    } catch {
      showToast('Select the command to copy it');
    }
  });
});

const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !reducedMotion) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.13 });
  reveals.forEach(element => observer.observe(element));
} else {
  reveals.forEach(element => element.classList.add('is-visible'));
}

const routes = [
  { from: 'research-agent', to: 'metrics-service' },
  { from: 'workspace-hub', to: 'product-app' },
  { from: 'metrics-service', to: 'workspace-hub' },
  { from: 'product-app', to: 'research-agent' },
];

let routeIndex = 0;
function updateRoute() {
  const route = routes[routeIndex % routes.length];
  document.querySelectorAll('[data-agent]').forEach(node => {
    node.classList.toggle('is-active', node.dataset.agent === route.from || node.dataset.agent === route.to);
  });
  document.querySelectorAll('[data-route]').forEach(element => { element.textContent = route.to; });
  document.querySelectorAll('[data-route-from]').forEach(element => { element.textContent = route.from; });
  document.querySelectorAll('[data-route-to]').forEach(element => { element.textContent = route.to; });
  routeIndex += 1;
}

updateRoute();
if (!reducedMotion) window.setInterval(updateRoute, 2800);

document.querySelectorAll('[data-year]').forEach(element => {
  element.textContent = new Date().getFullYear();
});
