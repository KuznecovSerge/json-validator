import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const schemaField = document.getElementById('schema');
const dataField = document.getElementById('data');

const allErrorsCheckbox = document.getElementById('allErrors');
const strictCheckbox = document.getElementById('strict');

function validate() {
    const schemaText = document.getElementById('schema').value;
    const jsonText = document.getElementById('data').value;
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
  schemaField.value = JSON.stringify({
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "age": { "type": "integer", "minimum": 0 }
    },
    "required": ["name"]
  }, null, 2);
}

function loadSampleData() {
  dataField.value = JSON.stringify({
    "name": "John",
    "age": 30
  }, null, 2);
}

function formatJSON(which) {
  const el = which === 'schema' ? schemaField : dataField;
  try {
    const parsed = JSON.parse(el.value);
    el.value = JSON.stringify(parsed, null, 2);
  } catch (e) {
    alert('Невалидный JSON: ' + e.message);
  }
}

function clearField(which) {
  (which === 'schema' ? schemaField : dataField).value = '';
}

document.getElementById('btn-format-schema').addEventListener('click', () => formatJSON('schema'));
document.getElementById('btn-sample-schema').addEventListener('click', loadSampleSchema);
document.getElementById('btn-clear-schema').addEventListener('click', () => clearField('schema'));

document.getElementById('btn-format-data').addEventListener('click', () => formatJSON('data'));
document.getElementById('btn-sample-data').addEventListener('click', loadSampleData);
document.getElementById('btn-clear-data').addEventListener('click', () => clearField('data'));

document.getElementById('btn-validate').addEventListener('click', validate);

// Примеры при загрузке
window.addEventListener('load', () => {
   loadSampleSchema();
   loadSampleData();
});