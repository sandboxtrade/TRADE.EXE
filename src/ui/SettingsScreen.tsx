import { useEffect, useMemo, useState } from "react";
import type { AppCheckState } from "../storage/firebase";
import type { AuthProfile } from "../storage/auth";
import type { RuntimeTrace } from "../engine/runtime";
import type { IntimacyPhase } from "../intimacy/intimacy";
import type { ConversationExportLimit } from "../chat/conversation-export";
import { MAX_MEMORY_CHARS, MAX_PERSONALITY_CHARS } from "../context/yuzuki-context";
import { DebugPanel } from "./components";

const appCheckLabels: Record<AppCheckState, string> = {
  checking: "проверяется",
  disabled: "не используется",
  missing_site_key: "нужен site key",
  debug: "debug mode",
  active: "защищён",
  error: "ошибка",
};

const intimacyPhaseLabels: Record<IntimacyPhase, string> = {
  normal: "спокойно",
  romantic: "романтика",
  close: "близость",
  intimate: "интимно",
  high_intimacy: "сильное влечение",
  aftercare: "нежность",
  paused: "пауза",
};

const exportOptions: Array<{ value: ConversationExportLimit; label: string }> = [
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 200, label: "200" },
  { value: "all", label: "Весь диалог" },
];

type SettingsView = "home" | "personality" | "memory" | "export";

function downloadText(text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `yuzuki-dialogue-${date}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function compactPreview(text: string, max = 155) {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean) return "Пока пусто";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function SettingsScreen({
  firebaseEnabled,
  appCheckState,
  user,
  trace,
  onSignOut,
  onClearConversationAndMemory,
  clearingData,
  resetDisabled,
  maintenanceError,
  intimacyEnabled,
  intimacyPhase,
  intimacyUpdating,
  onSetIntimacyEnabled,
  personality,
  memory,
  contextUpdatedAt,
  contextBusy,
  onReloadContext,
  onSavePersonality,
  onSaveMemory,
  exportBusy,
  onExportConversation,
}: {
  firebaseEnabled: boolean;
  appCheckState: AppCheckState;
  user: AuthProfile | null;
  trace: RuntimeTrace | null;
  onSignOut: () => void;
  onClearConversationAndMemory: () => Promise<void>;
  clearingData: boolean;
  resetDisabled: boolean;
  maintenanceError: string | null;
  intimacyEnabled: boolean;
  intimacyPhase: IntimacyPhase;
  intimacyUpdating: boolean;
  onSetIntimacyEnabled: (enabled: boolean) => Promise<void>;
  personality: string;
  memory: string;
  contextUpdatedAt: number;
  contextBusy: boolean;
  onReloadContext: () => Promise<void>;
  onSavePersonality: (text: string) => Promise<boolean>;
  onSaveMemory: (text: string) => Promise<boolean>;
  exportBusy: boolean;
  onExportConversation: (limit: ConversationExportLimit) => Promise<string>;
}) {
  const [view, setView] = useState<SettingsView>("home");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmAdultMode, setConfirmAdultMode] = useState(false);
  const [personalityDraft, setPersonalityDraft] = useState(personality);
  const [memoryDraft, setMemoryDraft] = useState(memory);
  const [exportText, setExportText] = useState("");
  const [exportLabel, setExportLabel] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");
  const [pasteState, setPasteState] = useState<"idle" | "ok" | "error">("idle");

  useEffect(() => setPersonalityDraft(personality), [personality]);
  useEffect(() => setMemoryDraft(memory), [memory]);

  const dialogueEngineLabel = useMemo(() => {
    if (!trace) return firebaseEnabled ? "ожидание" : "local";
    if (trace.cloudLanguage?.used) return `GPT · ${trace.cloudLanguage.model ?? "cloud"}`;
    if (trace.cloudLanguage?.attempted)
      return `LOCAL · ${trace.cloudLanguage?.reason ?? "fallback"}`;
    return "LOCAL";
  }, [firebaseEnabled, trace]);

  const contextDate = contextUpdatedAt
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(contextUpdatedAt)
    : "ещё не сохранялась";

  const copyExport = async () => {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
      setCopyState("ok");
    } catch {
      setCopyState("error");
    }
  };

  const pasteIntoEditor = async (target: "personality" | "memory") => {
    setPasteState("idle");
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (target === "personality") setPersonalityDraft(text.slice(0, MAX_PERSONALITY_CHARS));
      else setMemoryDraft(text.slice(0, MAX_MEMORY_CHARS));
      setPasteState("ok");
    } catch {
      setPasteState("error");
    }
  };

  const runExport = async (limit: ConversationExportLimit, label: string) => {
    setCopyState("idle");
    const text = await onExportConversation(limit);
    if (!text) return;
    setExportText(text);
    setExportLabel(label);
    setView("export");
  };

  if (view === "personality" || view === "memory") {
    const editingPersonality = view === "personality";
    const draft = editingPersonality ? personalityDraft : memoryDraft;
    const saved = editingPersonality ? personality : memory;
    const max = editingPersonality ? MAX_PERSONALITY_CHARS : MAX_MEMORY_CHARS;
    const title = editingPersonality ? "Личность Yuzuki" : "Память Yuzuki";
    const note = editingPersonality
      ? "Характер, голос, привычки и границы. Этот текст стабилен и читается перед каждым ответом."
      : "Совместная история и важные воспоминания. Можно целиком заменить текст новой сводкой из ChatGPT.";

    const save = async () => {
      const ok = editingPersonality
        ? await onSavePersonality(personalityDraft)
        : await onSaveMemory(memoryDraft);
      if (ok) setView("home");
    };

    const cancel = () => {
      if (editingPersonality) setPersonalityDraft(saved);
      else setMemoryDraft(saved);
      setPasteState("idle");
      setView("home");
    };

    return (
      <section className="panel-screen settings-screen settings-editor-view">
        <div className="settings-editor-toolbar">
          <button className="settings-back-button" type="button" onClick={cancel} disabled={contextBusy}>
            ← Назад
          </button>
          <div>
            <strong>{title}</strong>
            <span>{draft.length.toLocaleString("ru-RU")} / {max.toLocaleString("ru-RU")}</span>
          </div>
          <button className="settings-save-button" type="button" onClick={() => void save()} disabled={contextBusy || draft === saved}>
            {contextBusy ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>

        <p className="settings-editor-note">{note}</p>

        <textarea
          className="settings-full-editor"
          value={draft}
          maxLength={max}
          disabled={contextBusy}
          autoFocus
          spellCheck
          placeholder={editingPersonality ? "Опиши Yuzuki…" : "Вставь сюда сводку памяти…"}
          onChange={(event) => {
            if (editingPersonality) setPersonalityDraft(event.target.value);
            else setMemoryDraft(event.target.value);
            setPasteState("idle");
          }}
        />

        <div className="settings-editor-footer">
          <button type="button" disabled={contextBusy} onClick={() => void pasteIntoEditor(view)}>
            Вставить из буфера
          </button>
          <span>
            {pasteState === "ok" ? "Вставлено" : pasteState === "error" ? "Не удалось прочитать буфер" : "Переносы строк сохраняются"}
          </span>
        </div>
      </section>
    );
  }

  if (view === "export") {
    return (
      <section className="panel-screen settings-screen settings-editor-view settings-export-view">
        <div className="settings-editor-toolbar">
          <button className="settings-back-button" type="button" onClick={() => setView("home")}>← Назад</button>
          <div>
            <strong>Экспорт диалога</strong>
            <span>{exportLabel}</span>
          </div>
          <button className="settings-save-button" type="button" onClick={() => void copyExport()}>
            {copyState === "ok" ? "Скопировано" : copyState === "error" ? "Ошибка" : "Скопировать"}
          </button>
        </div>
        <p className="settings-editor-note">Чистая переписка USER/YUZUKI без технических событий. Её можно передать ChatGPT для обновления Personality и Memory.</p>
        <textarea className="settings-full-editor settings-export-editor" value={exportText} readOnly />
        <div className="settings-editor-footer">
          <button type="button" onClick={() => downloadText(exportText)}>Скачать .txt</button>
          <span>{exportText.length.toLocaleString("ru-RU")} символов</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel-screen settings-screen settings-home">
      <div className="settings-page-head">
        <div>
          <span className="eyebrow">YUZUKI</span>
          <h2>Настройки</h2>
          <p>Личность и память вынесены в отдельные полноэкранные редакторы — без тесного окна поверх фотографии.</p>
        </div>
        <button type="button" disabled={contextBusy} onClick={() => void onReloadContext()}>
          {contextBusy ? "…" : "Обновить"}
        </button>
      </div>

      <div className="settings-section-card">
        <div className="settings-section-title">
          <strong>Личность и память</strong>
          <span>обновлено: {contextDate}</span>
        </div>
        <button className="settings-entry" type="button" onClick={() => setView("personality")}>
          <div>
            <strong>Личность Yuzuki</strong>
            <span>{compactPreview(personality)}</span>
          </div>
          <small>{personality.length.toLocaleString("ru-RU")} / {MAX_PERSONALITY_CHARS.toLocaleString("ru-RU")} ›</small>
        </button>
        <button className="settings-entry" type="button" onClick={() => setView("memory")}>
          <div>
            <strong>Память Yuzuki</strong>
            <span>{compactPreview(memory)}</span>
          </div>
          <small>{memory.length.toLocaleString("ru-RU")} / {MAX_MEMORY_CHARS.toLocaleString("ru-RU")} ›</small>
        </button>
      </div>

      <div className="settings-section-card">
        <div className="settings-section-title">
          <strong>Экспорт диалога</strong>
          <span>для ручного обновления памяти</span>
        </div>
        <p className="settings-section-copy">Выбери объём. Результат откроется на весь экран, откуда его можно скопировать или скачать.</p>
        <div className="export-choice-row settings-export-choices">
          {exportOptions.map((option) => (
            <button
              type="button"
              key={String(option.value)}
              disabled={exportBusy}
              onClick={() => void runExport(option.value, option.label)}
            >
              {exportBusy ? "…" : option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section-card">
        <div className="settings-section-title">
          <strong>Интимный режим 18+</strong>
          <span>{intimacyEnabled ? `включён · ${intimacyPhaseLabels[intimacyPhase]}` : "выключен"}</span>
        </div>
        <p className="settings-section-copy">Стоп, пауза и границы всегда имеют приоритет над текущим состоянием близости.</p>
        {intimacyEnabled ? (
          <button className="settings-wide-button" type="button" disabled={intimacyUpdating || clearingData} onClick={() => void onSetIntimacyEnabled(false)}>
            {intimacyUpdating ? "Сохраняем…" : "Выключить"}
          </button>
        ) : !confirmAdultMode ? (
          <button className="settings-wide-button" type="button" disabled={intimacyUpdating || clearingData} onClick={() => setConfirmAdultMode(true)}>
            Включить
          </button>
        ) : (
          <div className="settings-inline-confirmation" role="alert">
            <span>Режим предназначен только для взрослых пользователей.</span>
            <div>
              <button type="button" disabled={intimacyUpdating} onClick={() => setConfirmAdultMode(false)}>Отмена</button>
              <button type="button" disabled={intimacyUpdating} onClick={() => void onSetIntimacyEnabled(true).finally(() => setConfirmAdultMode(false))}>
                {intimacyUpdating ? "Сохраняем…" : "Мне 18+ · включить"}
              </button>
            </div>
          </div>
        )}
      </div>

      <details className="settings-details-card">
        <summary>Диагностика и подключение</summary>
        <div className="settings-list">
          <div className="setting-row"><span>Аккаунт</span><strong>{user?.email ?? "Локальный пользователь"}</strong></div>
          <div className="setting-row"><span>Firebase</span><strong>{firebaseEnabled ? "подключён" : "локальный режим"}</strong></div>
          <div className="setting-row"><span>App Check</span><strong>{appCheckLabels[appCheckState]}</strong></div>
          <div className="setting-row"><span>Диалог</span><strong>{dialogueEngineLabel}</strong></div>
          <div className="setting-row"><span>Контекст GPT</span><strong>Personality + Memory + 15/15</strong></div>
        </div>
        {trace?.timings && (
          <div className="settings-list timings-list">
            <div className="setting-row"><span>До первого текста</span><strong>{trace.timings.firstTextMs === null ? "без реплики" : `${(trace.timings.firstTextMs / 1000).toFixed(1)} с`}</strong></div>
            <div className="setting-row"><span>Контекст</span><strong>{((trace.timings.preflightMs + trace.timings.contextMs) / 1000).toFixed(1)} с</strong></div>
            <div className="setting-row"><span>Формулировка ответа</span><strong>{(trace.timings.generationMs / 1000).toFixed(1)} с</strong></div>
            <div className="setting-row"><span>Сохранение</span><strong>{(trace.timings.saveMs / 1000).toFixed(1)} с</strong></div>
            <div className="setting-row"><span>Всего</span><strong>{(trace.timings.totalMs / 1000).toFixed(1)} с</strong></div>
          </div>
        )}
        {maintenanceError && <div className="error-card">Фоновое состояние: {maintenanceError}</div>}
        <DebugPanel trace={trace} />
      </details>

      <div className="settings-section-card settings-danger-card">
        <div className="settings-section-title">
          <strong>Очистить диалог и память</strong>
          <span>личность сохранится</span>
        </div>
        <p className="settings-section-copy">Удалит историю общения и ручную Memory. Personality Yuzuki останется.</p>
        {!confirmReset ? (
          <button className="danger-button settings-wide-button" type="button" disabled={resetDisabled} onClick={() => setConfirmReset(true)}>
            Очистить диалог и память
          </button>
        ) : (
          <div className="settings-inline-confirmation" role="alert">
            <span>Это действие необратимо.</span>
            <div>
              <button type="button" disabled={clearingData} onClick={() => setConfirmReset(false)}>Отмена</button>
              <button className="danger-button" type="button" disabled={resetDisabled} onClick={() => void onClearConversationAndMemory().finally(() => setConfirmReset(false))}>
                {clearingData ? "Очищаем…" : "Удалить всё"}
              </button>
            </div>
          </div>
        )}
      </div>

      {user && (
        <button className="secondary-button settings-signout" type="button" onClick={onSignOut} disabled={clearingData}>
          Выйти из Google
        </button>
      )}
    </section>
  );
}
