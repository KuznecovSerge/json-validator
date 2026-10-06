import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { JsonFolder, getFullValue } from "./json-fold.js";
import { registerFolder, attachExternalSync } from "./external-sync.js";

const schemaField = document.getElementById('schema');
const dataField = document.getElementById('data');

// ---------- Сворачивание блоков JSON (создаём папки как можно раньше,
// до навешивания обработчиков кнопок) ----------
const folders = {
  schema: new JsonFolder(schemaField),
  data: new JsonFolder(dataField),
};
registerFolder(schemaField, folders.schema);
registerFolder(dataField, folders.data);
attachExternalSync(); // перехват внешнего ta.value = ... (MutationObserver)

function fullText(which) {
  return getFullValue(which === 'schema' ? schemaField : dataField);
}

function setFullText(which, text) {
  const f = which === 'schema' ? folders.schema : folders.data;
  // пишем в модель folder'а и перерисовываем — так корректно работает
  // режим маскирования при свёрнутых блоках
  f.allLines = text.split("\n");
  f.folded.clear();
  f.refresh();
}

const allErrorsCheckbox = document.getElementById('allErrors');
const strictCheckbox = document.getElementById('strict');

function validate() {
    // значение textarea может быть «замаскировано» (есть свёрнутые блоки) —
    // читаем ПОЛНЫЙ текст из модели folder'а
    refreshFolders();
    const schemaText = fullText('schema');
    const jsonText = fullText('data');
    const resultDiv = document.getElementById('result');
    
    resultDiv.innerHTML = '';
    resultDiv.className = 'result';
    
    let schema, jsonData;
    
    try {
        schema = JSON.parse(schemaText);
    } catch (e) {
        resultDiv.classList.add('error');
        resultDiv.innerHTML = `
            <h3>Ошибка в JSON Schema</h3>
            <div class="error-item">
                <div class="error-message">${escapeHtml(e.message)}</div>
            </div>
        `;
        return;
    }
    
    try {
        jsonData = JSON.parse(jsonText);
    } catch (e) {
        resultDiv.classList.add('error');
        resultDiv.innerHTML = `
            <h3>Ошибка в JSON</h3>
            <div class="error-item">
                <div class="error-message">${escapeHtml(e.message)}</div>
            </div>
        `;
        return;
    }
    
    try {
        const ajv = new Ajv2020({ 
            allErrors: allErrorsCheckbox.checked,
            strict: strictCheckbox.checked,
            verbose: true
        });
        addFormats(ajv);
        
        const validate = ajv.compile(schema);
        const valid = validate(jsonData);
        
        if (valid) {
            resultDiv.classList.add('success');
            resultDiv.innerHTML = '<h3>✓ Валидация успешна</h3><p>JSON соответствует схеме.</p>';
        } else {
            resultDiv.classList.add('error');
            let errorsHtml = '<h3>✗ Ошибки валидации</h3><ul class="error-list">';
            
            validate.errors.forEach(error => {
                const path = error.instancePath || '(корень)';
                errorsHtml += `
                    <li class="error-item">
                        <div class="error-path">Путь: ${escapeHtml(path)}</div>
                        <div class="error-message">${escapeHtml(error.message || 'Неизвестная ошибка')}</div>
                        <div class="error-details">
                            <strong>Keyword:</strong> ${escapeHtml(error.keyword)}<br>
                            <strong>Params:</strong> ${escapeHtml(JSON.stringify(error.params, null, 2))}
                        </div>
                    </li>
                `;
            });
            
            errorsHtml += '</ul>';
            resultDiv.innerHTML = errorsHtml;
        }
    } catch (e) {
        resultDiv.classList.add('error');
        resultDiv.innerHTML = `
            <h3>Ошибка компиляции схемы</h3>
            <div class="error-item">
                <div class="error-message">${escapeHtml(e.message)}</div>
            </div>
        `;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function loadSampleSchema() {
  setFullText('schema', JSON.stringify({
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "age": { "type": "integer", "minimum": 0 }
    },
    "required": ["name"]
  }, null, 2));
}

function loadSampleData() {
  setFullText('data', JSON.stringify({
    "name": "John",
    "age": 30
  }, null, 2));
}

function formatJSON(which) {
  const text = fullText(which);
  try {
    const parsed = JSON.parse(text);
    setFullText(which, JSON.stringify(parsed, null, 2));
  } catch (e) {
    alert('Невалидный JSON: ' + e.message);
  }
}

function clearField(which) {
  setFullText(which, '');
}

document.getElementById('btn-format-schema').addEventListener('click', () => formatJSON('schema'));
document.getElementById('btn-sample-schema').addEventListener('click', loadSampleSchema);
document.getElementById('btn-clear-schema').addEventListener('click', () => clearField('schema'));

document.getElementById('btn-format-data').addEventListener('click', () => formatJSON('data'));
document.getElementById('btn-sample-data').addEventListener('click', loadSampleData);
document.getElementById('btn-clear-data').addEventListener('click', () => clearField('data'));

document.getElementById('btn-validate').addEventListener('click', validate);

function refreshFolders() {
  folders.schema.refresh();
  folders.data.refresh();
}

for (const which of ['schema', 'data']) {
  document.getElementById(`btn-foldall-${which}`).addEventListener('click', () => folders[which].foldAll());
  document.getElementById(`btn-unfoldall-${which}`).addEventListener('click', () => folders[which].unfoldAll());
}

// Примеры при загрузке
window.addEventListener('load', () => {
   loadSampleSchema();
   loadSampleData();
});