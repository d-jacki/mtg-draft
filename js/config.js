// Lega predefinita: chi apre l'app è già collegato in sola lettura; per registrare i tornei basta il PIN
// (Lega → Dati e sync). URL e chiave publishable sono pubblici per natura: la scrittura è protetta dal PIN,
// con blocco dopo troppi tentativi sbagliati (vedi supabase/schema.sql). Mai mettere qui la secret key.
// null = nessuna lega predefinita (ognuno si collega a mano).

const DEFAULT_LEAGUE = {
  url: 'https://ovsqmxantbeuyyijwatl.supabase.co',
  key: 'sb_publishable_IU6_qulT9KgJEBa3BjahIQ_JVJsckwU',
  league: 'e97f24de-7bc0-4835-a899-8fb59c526a27',
  name: '',
};
