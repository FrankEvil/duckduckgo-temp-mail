import { DuckProfile } from "../../shared/types/profile";

export type AppSettings = {
  profiles: DuckProfile[];
  activeProfileId: string | null;
};
