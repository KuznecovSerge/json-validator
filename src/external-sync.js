// external-sync.js — перехват внешнего изменения textarea.
//
// Кнопки «Форматировать», «Пример», «Очистить» в index.js присваивают
// textarea его .value напрямую, минуя JsonFolder. Если редактор сейчас
// находится в режиме маскирования (есть свёрнутые блоки), такое присваивание
// синхронизируется через MutationObserver: полный текст попадает в модель
// folder'а, после чего маска перестраивается.

const registry = new WeakMap(); // textarea -> JsonFolder

export function registerFolder(ta, folder) {
  registry.set(ta, folder);
}

export function attachExternalSync() {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "value") {
        const ta = m.target;
        const f = registry.get(ta);
        if (!f || f.suppress) continue; // программное значение от самого folder
        // внешнее присваивание value — обновляем полную модель и перерисовываем
        f.allLines = ta.value.split("\n");
        f.folded.clear(); // структура текста изменилась целиком — разворачиваем
        f.refresh();
      }
    }
  });
  for (const ta of registry.keys()) {
    observer.observe(ta, { attributes: true, attributeFilter: ["value"] });
  }
  return observer;
}
