import { sessions } from "./sessions";

export function markSessionAsReady(companySlug: string) {
  sessions[companySlug].ready = true;
  sessions[companySlug].connecting = false;
  sessions[companySlug].qrCode = null;
}
