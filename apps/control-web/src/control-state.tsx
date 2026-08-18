import { createContext, useContext, type ReactNode } from "react";

export interface DisplayActor {
  username: string;
  role: "operator" | "reader";
  transport: "session" | "development";
}

interface ControlState {
  actor: DisplayActor;
  writeMode: "disabled" | "canary" | "enabled" | "unknown";
  writesAllowed: boolean;
}

const Context = createContext<ControlState | null>(null);

export function ControlStateProvider({
  actor,
  writeMode,
  children,
}: {
  actor: DisplayActor;
  writeMode: ControlState["writeMode"];
  children: ReactNode;
}) {
  return (
    <Context.Provider
      value={{
        actor,
        writeMode,
        writesAllowed:
          actor.role === "operator" &&
          (writeMode === "canary" || writeMode === "enabled"),
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useControlState(): ControlState {
  const value = useContext(Context);
  if (!value) throw new Error("control state is unavailable");
  return value;
}
