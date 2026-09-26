import { useEffect, useState } from "react";
import { useAppStore } from "./app/store";
import { defaultCharacter } from "./character/character";
import {
  isFirebaseConfigured,
  isLocalRepositoryAllowed,
  runtimeConfigurationError,
} from "./storage/firebase";
import { AuthGate } from "./ui/components";
import { BottomNav, type AppTab } from "./ui/components";
import { CharacterStage } from "./ui/CharacterStage";
import { ChatScreen } from "./ui/ChatScreen";
import { CustomizeScreen } from "./ui/SecondaryScreens";
import { SettingsScreen } from "./ui/SettingsScreen";
import { TogetherScreen } from "./ui/SecondaryScreens";
import "./styles.css";

export default function App() {
  const {
    ready,
    initializing,
    busy,
    messages,
    runtime,
    lastTrace,
    authStatus,
    user,
    appCheckState,
    error,
    initialize,
    signIn,
    signOut,
    clearConversationAndMemory,
    resettingData,
    setIntimacyAdultMode,
    updatingIntimacyMode,
    send,
    clearError,
    retry,
    dismissFailed,
    streamingText,
    chatDraft,
    setChatDraft,
    phase,
    maintenanceError,
    reconcileWorld,
    hasOlderMessages,
    loadingOlder,
    loadOlder,
    editablePersonality,
    editableMemory,
    editableContextUpdatedAt,
    editableContextBusy,
    exportBusy,
    loadEditableContext,
    saveEditablePersonality,
    saveEditableMemory,
    exportConversation,
  } = useAppStore();
  const [activeTab, setActiveTab] = useState<AppTab>("chat");
  const settingsOpen = activeTab === "settings";
  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const onFocus = () => reconcileWorld(true);
    const onOnline = () => reconcileWorld(true);
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcileWorld(true);
    };
    const clockTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") reconcileWorld(false);
    }, 60_000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(clockTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reconcileWorld]);

  if (isFirebaseConfigured && authStatus === "signed_out") {
    return <AuthGate busy={busy} error={error} onSignIn={() => void signIn()} />;
  }

  const transportKind = runtimeConfigurationError
    ? "config"
    : lastTrace?.cloudLanguage?.used
      ? "gpt"
      : lastTrace?.cloudLanguage?.attempted
        ? "local"
        : isLocalRepositoryAllowed
          ? "local"
          : "cloud";
  const transportLabel =
    transportKind === "config"
      ? "CONFIG"
      : transportKind === "gpt"
        ? "GPT"
        : transportKind === "local"
          ? "LOCAL"
          : "CLOUD";
  const companionStatus = initializing
    ? "просыпается…"
    : ready
      ? busy
        ? "отвечает тебе"
        : "рядом"
      : "подключение…";

  return (
    <main className={`app-shell${settingsOpen ? " settings-mode" : ""}`}>
      <header className="topbar">
        <div className="brand-block">
          <span className="mini-avatar">{defaultCharacter.name.slice(0, 1)}</span>
          <div>
            <strong>{defaultCharacter.name}</strong>
            <small>{companionStatus}</small>
          </div>
        </div>
        <div className={`top-status top-status-${transportKind}`}>
          <span className={ready ? "status-dot online" : "status-dot"} />
          <span>{transportLabel}</span>
        </div>
      </header>

      {!settingsOpen && (
        <CharacterStage
          runtime={runtime}
          busy={busy}
          onQuietAction={(text) => {
            setActiveTab("chat");
            void send(text);
          }}
          quietActionDisabled={!ready || busy}
        />
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              clearError();
              if (!ready) void initialize();
            }}
          >
            {!ready ? "Повторить" : "×"}
          </button>
        </div>
      )}

      <div className={`content-area${settingsOpen ? " settings-content-area" : ""}`}>
        {activeTab === "chat" && (
          <ChatScreen
            messages={messages}
            ready={ready}
            busy={busy}
            onSend={send}
            draft={chatDraft}
            onDraftChange={setChatDraft}
            streamingText={streamingText}
            phase={phase}
            onRetry={retry}
            onDismissFailed={dismissFailed}
            hasOlderMessages={hasOlderMessages}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlder}
          />
        )}
        {activeTab === "together" && <TogetherScreen />}
        {activeTab === "look" && <CustomizeScreen mode="look" />}
        {activeTab === "room" && <CustomizeScreen mode="room" />}
        {activeTab === "settings" && (
          <SettingsScreen
            firebaseEnabled={isFirebaseConfigured && !runtimeConfigurationError}
            appCheckState={appCheckState}
            user={user}
            trace={lastTrace}
            maintenanceError={maintenanceError}
            onSignOut={() => void signOut()}
            onClearConversationAndMemory={clearConversationAndMemory}
            clearingData={resettingData}
            resetDisabled={!ready || resettingData}
            intimacyEnabled={runtime?.intimacy?.adultModeEnabled === true}
            intimacyPhase={runtime?.intimacy?.phase ?? "normal"}
            intimacyUpdating={updatingIntimacyMode}
            onSetIntimacyEnabled={setIntimacyAdultMode}
            personality={editablePersonality}
            memory={editableMemory}
            contextUpdatedAt={editableContextUpdatedAt}
            contextBusy={editableContextBusy}
            onReloadContext={loadEditableContext}
            onSavePersonality={saveEditablePersonality}
            onSaveMemory={saveEditableMemory}
            exportBusy={exportBusy}
            onExportConversation={exportConversation}
          />
        )}
      </div>

      <BottomNav active={activeTab} onChange={setActiveTab} />
    </main>
  );
}
