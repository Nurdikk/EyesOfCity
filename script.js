// Функция озвучки и дублирования текста на визуальное табло
function speakText(text) {
    const outputBox = document.getElementById('screenReaderOutput');
    if (outputBox) {
        outputBox.innerText = "🔊 Диктор говорит: " + text;
        outputBox.style.transform = "scale(1.01)";
        setTimeout(() => { outputBox.style.transform = "scale(1)"; }, 200);
    }

    if (!('speechSynthesis' in window)) {
        return;
    }

    window.speechSynthesis.cancel(); // Остановить предыдущую речь
    let utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
}

// Переключение режима высокой контрастности
function toggleContrast() {
    document.body.classList.toggle('high-contrast');
    if (document.body.classList.contains('high-contrast')) {
        speakText("Включен режим высокого контраста");
    } else {
        speakText("Включен обычный режим");
    }
}

// Открытие категории
function selectCategory(name) {
    speakText("Выбрана категория: " + name);
    alert("Открываем категорию: " + name);
}

// Голосовой ассистент
function startVoiceAssistant() {
    window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!window.SpeechRecognition) {
        alert("Ваш браузер не поддерживает распознавание речи. Используйте Google Chrome.");
        return;
    }

    const recognition = new window.SpeechRecognition();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    
    const statusText = document.getElementById('commandStatus');
    statusText.innerText = "Статус: Слушаю вас...";
    speakText("Слушаю вашу команду. Называйте категорию.");

    try {
        recognition.start();
    } catch (e) {
        console.error(e);
    }

    recognition.onresult = function(event) {
        const command = event.results[0][0].transcript.toLowerCase();
        statusText.innerText = "Вы сказали: " + command;
        
        if (command.includes('аптек')) {
            speakText("Открываю аптеки");
            selectCategory('Аптеки');
        } 
        else if (command.includes('контраст') || command.includes('темный')) {
            toggleContrast();
        } 
        else if (command.includes('поликлиник')) {
            speakText("Открываю поликлиники");
            selectCategory('Поликлиники');
        } 
        else if (command.includes('цон')) {
            speakText("Открываю ЦОНы");
            selectCategory('ЦОНы');
        }
        else if (command.includes('остановк')) {
            speakText("Открываю остановки");
            selectCategory('Остановки');
        }
        else {
            speakText("Команда не распознана: " + command);
        }
    };

    recognition.onerror = function() {
        statusText.innerText = "Статус: Не удалось распознать голос.";
        speakText("Не удалось распознать голос.");
    };

    recognition.onend = function() {
        setTimeout(() => {
            if (statusText.innerText.includes('Слушаю')) {
                statusText.innerText = "Статус: Ожидание команды...";
            }
        }, 2000);
    };
}