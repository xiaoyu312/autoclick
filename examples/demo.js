'use strict';

let count = 0;
let toggleCount = 0;
document.getElementById('count-button').addEventListener('click', () => {
  document.getElementById('count').textContent = String(++count);
});
document.getElementById('toggle-slot').addEventListener('click', (event) => {
  if (!event.target.closest('button')) return;
  const current = document.getElementById('toggle-button');
  const replacement = document.createElement('button');
  replacement.id = 'toggle-button';
  replacement.type = 'button';
  replacement.textContent = current.textContent === '讲解' ? '取消讲解' : '讲解';
  current.replaceWith(replacement);
  document.getElementById('toggle-count').textContent = `DOM clicks: ${++toggleCount}`;
});
