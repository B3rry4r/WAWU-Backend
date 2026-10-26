-- LEGAL-DOCS (owner ruling, 26 Oct 2026): writes the owner's nine legal documents, word for word, into "LegalDocument".
-- The text is the owner's (Mr Lennox's documents, received 26 Oct 2026): this file only lays it out as sections
-- ({ heading, body }). The only changes to the owner's text are the ones the owner allowed: sections numbered 1, 2, 3 in order,
-- the Privacy Policy's title without the em-dash, and "#1000" written as the naira amount. Nothing is invented.
-- Anything before a document's first numbered section (its title line, the line under it, the dates, an opening paragraph)
-- is kept as a first section headed by the first line.
--
-- Data only: no table, column or index is added, changed or dropped. Old code reads only terms and privacy and ignores the
-- other seven rows. The write is an upsert on the slug: a Terms or Privacy row the owner already saved is REPLACED by this
-- newer version (owner ruling, 26 Oct 2026); the replaced text is not kept here. Running it again writes the same rows.
-- Every row gets the fixed "updatedAt" below, which marks a row as written by this migration: the dashboard's save sets
-- "updatedAt" to the time of the save, so rollback.sql can tell an untouched row from one the owner has edited since.
-- Rollback: see rollback.sql (refuses while any of the nine has been edited since).

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'privacy',
  $lgd$PRIVACY POLICY: WHO MADE THIS? (WMT)$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "PRIVACY POLICY: WHO MADE THIS? (WMT)",
  "body": "A WAWU Technology Ltd Product\n\nLast Updated: 26 October 2026\nEffective Date: 26 October 2026"
 },
 {
  "heading": "1. INTRODUCTION AND SCOPE",
  "body": "This Privacy Policy explains how WAWU Technology Ltd (\"WAWU,\" \"we,\" \"us,\" or \"our\") collects, uses, stores, shares, and protects personal data when you use the WHO MADE THIS? (WMT) mobile application, website (wawuafrica.com), and related services (collectively, the \"Platform\").\n\nWMT is the creators and professionals monetization platform operated by WAWU. This Policy applies to all users of the Platform, including creators, professionals, businesses, and visitors.\n\nThis Policy is drafted to comply with the Nigeria Data Protection Act 2023 (NDPA), the NDPA General Application and Implementation Directive 2025 (GAID), the UK General Data Protection Regulation (UK GDPR) where applicable, and the privacy requirements of the Apple App Store and Google Play Store.\n\nBy accessing or using the Platform, you acknowledge that you have read and understood this Privacy Policy. Where processing is based on consent, you have the right to withdraw that consent at any time."
 },
 {
  "heading": "2. DEFINITIONS",
  "body": "Personal Data means any information relating to an identified or identifiable natural person.\n\nData Subject means the individual to whom personal data relates (you).\n\nData Controller means WAWU Technology Ltd, which determines the purposes and means of processing.\n\nData Processor means a third party that processes personal data on behalf of WAWU.\n\nProcessing means any operation performed on personal data, including collection, storage, use, disclosure, and deletion.\n\nSensitive Personal Data means data revealing racial or ethnic origin, political opinions, religious beliefs, health, genetic or biometric data, or data concerning a person's sex life."
 },
 {
  "heading": "3. DATA WE COLLECT",
  "body": "We collect the following categories of personal data:\n\nInformation You Provide Directly\n\nWe collect your identity data, including your full name, username, date of birth, and government-issued ID for verification purposes. We collect your contact data, including email address, phone number, and physical address. We collect your profile data, including profile photo, bio, discipline, and portfolio links. We collect your content data, including the music, designs, videos, photographs, written works, courses, and products you upload. We collect your financial data, including bank account details, wallet information, and payment history. We collect your verification data, including government-issued ID, biometric data for liveness checks, and self-attested documents. We also collect communication data, including messages, support tickets, feedback, and survey responses.\n\nInformation Collected Automatically\n\nWe collect device data, including device type, operating system, unique device identifiers, and mobile network. We collect usage data, including features accessed, time spent, pages viewed, and interactions. We collect approximate location data at the city or region level. We collect log data, including IP address, access times, error logs, and crash reports.\n\nInformation from Third Parties\n\nWe receive identity verification results from our KYC partners. We receive transaction confirmations and payment status from payment processors. If you sign in via Google, Apple, or other social login providers, we receive basic profile information. We may receive information from partners who refer you to the Platform, such as training programs and innovation hubs."
 },
 {
  "heading": "4. HOW WE USE YOUR DATA",
  "body": "We process personal data for the following purposes and lawful bases:\n\nWe create and manage your account on the basis of performance of a contract.\n\nWe verify your identity and prevent fraud on the basis of legal obligation and legitimate interest.\n\nWe enable you to sell products and services and receive payments on the basis of performance of a contract.\n\nWe process transactions and payouts on the basis of performance of a contract and legal obligation.\n\nWe provide customer support on the basis of performance of a contract and legitimate interest.\n\nWe improve and develop the Platform on the basis of legitimate interest.\n\nWe send service-related communications, including receipts and security alerts, on the basis of performance of a contract and legal obligation.\n\nWe send marketing communications only where you have given consent.\n\nWe comply with legal and regulatory obligations, including those of the NDPC, FCCPC, and tax authorities, on the basis of legal obligation.\n\nWe enforce our Terms of Service on the basis of legitimate interest.\n\nWe protect against security threats on the basis of legitimate interest and legal obligation.\n\nWe will only send you marketing communications where you have opted in. You can withdraw consent at any time by using the unsubscribe link in any email or by contacting us."
 },
 {
  "heading": "5. DATA SHARING AND DISCLOSURE",
  "body": "We do not sell your personal data. We share data only as described below.\n\nService Providers (Data Processors)\n\nWe engage trusted third parties to perform services on our behalf. These include payment processors, cloud hosting providers, identity verification partners, communication providers, analytics providers, and customer support platforms. All processors are contractually bound to protect your data and process it only on our instructions.\n\nPartners\n\nWhere you engage with a partner through the Platform, including training providers, logistics partners, and streaming partners, we may share necessary data to facilitate the service. Partners are required to comply with applicable data protection laws.\n\nLegal and Regulatory Disclosures\n\nWe may disclose personal data where required by law, court order, or a competent authority. This includes the Nigeria Data Protection Commission (NDPC), the Federal Competition and Consumer Protection Commission (FCCPC), law enforcement agencies, and tax authorities.\n\nBusiness Transfers\n\nIn the event of a merger, acquisition, or sale of assets, personal data may be transferred. We will notify you of any such change and your rights.\n\nWith Your Consent\n\nWe may share data for other purposes where you have given explicit consent."
 },
 {
  "heading": "6. CROSS-BORDER DATA TRANSFERS",
  "body": "WAWU is incorporated in Nigeria. Where we transfer personal data outside Nigeria, we comply with Part VIII of the NDPA and Schedule 5 of the GAID.\n\nWe may transfer data to a country deemed adequate by the NDPC. We may use a Cross-Border Data Transfer Instrument (CBDTI), including approved contractual clauses, binding corporate rules, or codes of conduct. We may rely on derogations where you have given explicit consent after being informed of risks, where necessary for contract performance, for legal claims, or for vital interests.\n\nWhere we use international service providers, including cloud hosting, we ensure appropriate safeguards are in place, including standard contractual clauses approved by the NDPC.\n\nWhere UK data subjects are involved, we comply with UK international transfer requirements."
 },
 {
  "heading": "7. DATA SECURITY",
  "body": "We implement robust technical and organizational measures to protect personal data. These include encryption of data in transit (TLS/SSL) and at rest, access controls and role-based permissions, multi-factor authentication for administrative access, regular security audits and vulnerability assessments, employee training on data protection, and incident response and breach notification procedures.\n\nIn the event of a personal data breach likely to result in a risk to your rights and freedoms, we will notify the NDPC within 72 hours and inform you without undue delay where the breach is likely to result in high risk."
 },
 {
  "heading": "8. DATA RETENTION",
  "body": "We retain personal data only for as long as necessary to fulfill the purposes for which it was collected.\n\nWe retain account data for the duration of your account plus seven years to meet legal and tax requirements.\n\nWe retain verification data for the duration of your account plus seven years for regulatory compliance.\n\nWe retain transaction records for seven years in accordance with financial regulations.\n\nWe retain content data until you delete it or close your account, then for a further 90 days.\n\nWe retain communication data for three years from the last interaction.\n\nWe retain usage and analytics data for two years, after which it is aggregated or anonymized.\n\nWhen retention periods expire, we securely delete or anonymize the data."
 },
 {
  "heading": "9. YOUR RIGHTS",
  "body": "Under the NDPA and applicable laws, you have the following rights.\n\nYou have the right to be informed about what data we collect and how we use it.\n\nYou have the right to access a copy of your personal data.\n\nYou have the right to rectification of inaccurate or incomplete data.\n\nYou have the right to erasure, also known as the right to be forgotten, subject to legal retention obligations.\n\nYou have the right to restrict processing, limiting how we process your data.\n\nYou have the right to data portability, receiving your data in a structured, machine-readable format.\n\nYou have the right to object to processing based on legitimate interests.\n\nYou have the right to withdraw consent at any time where processing is based on consent.\n\nYou have the right to lodge a complaint with the Nigeria Data Protection Commission (NDPC).\n\nTo exercise your rights, contact our Data Protection Officer at privacy@wawuafrica.com. We will respond within 30 days. We may need to verify your identity before processing your request.\n\nYou can delete your account from within the app (Settings > Account > Delete Account) or by contacting support@wawuafrica.com. Deleting your account removes your profile and content, subject to legal retention requirements."
 },
 {
  "heading": "10. CHILDREN'S PRIVACY",
  "body": "The Platform is not intended for individuals under the age of 18. We do not knowingly collect personal data from children. If we become aware that a child has provided personal data, we will delete it promptly. If you believe a child has provided data, contact us at privacy@wawuafrica.com."
 },
 {
  "heading": "11. COOKIES AND TRACKING TECHNOLOGIES",
  "body": "We use cookies, pixels, and similar technologies on our website and app to maintain your session and preferences, to analyze usage and improve the Platform, and to deliver relevant marketing where you have given consent.\n\nYou can manage cookie preferences through your browser settings. For app tracking, you can control permissions through your device settings."
 },
 {
  "heading": "12. THIRD-PARTY LINKS AND SERVICES",
  "body": "The Platform may contain links to third-party websites or integrate third-party services, including payment processors and streaming partners. This Privacy Policy does not apply to those third parties. We encourage you to review their privacy policies."
 },
 {
  "heading": "13. AUTOMATED DECISION-MAKING",
  "body": "We may use automated processes for identity verification, including automated checks against databases and biometric liveness detection, and for fraud detection, including automated monitoring for suspicious activity.\n\nYou have the right to request human review of automated decisions that significantly affect you. Contact privacy@wawuafrica.com."
 },
 {
  "heading": "14. CHANGES TO THIS POLICY",
  "body": "We may update this Privacy Policy from time to time. We will notify you of material changes via email or in-app notification at least 14 days before they take effect. The \"Last Updated\" date at the top indicates when the Policy was last revised. Continued use of the Platform after changes constitutes acceptance."
 },
 {
  "heading": "15. CONTACT US",
  "body": "Data Controller: WAWU Technology Ltd\nRegistered Address: 5 Ikoyi Crescent, Lagos, Nigeria\n\nData Protection Officer (DPO):\nEmail: privacy@wawuafrica.com\nPhone: +234 705 072 2222\n\nSupport:\nEmail: support@wawuafrica.com\nWhatsApp: +234 705 072 2222\n\nRegulatory Authority:\nNigeria Data Protection Commission (NDPC)\nWebsite: ndpc.gov.ng"
 },
 {
  "heading": "16. APP STORE SPECIFIC DISCLOSURES",
  "body": "Apple App Store\n\nThis Privacy Policy is accessible via the App Store product page and within the app (Settings > Privacy Policy). Our App Privacy disclosures in App Store Connect are consistent with this Policy.\n\nGoogle Play Store\n\nThis Privacy Policy is hosted at an active, publicly accessible, non-geofenced URL and is linked in Play Console and within the app. Our Data Safety declarations are consistent with this Policy."
 },
 {
  "heading": "17. SPECIAL PROVISIONS FOR CREATOR MONETIZATION",
  "body": "Financial Data\n\nTo enable you to receive payments, we collect bank account details and transaction information. This data is shared with licensed payment processors and is subject to financial regulatory retention requirements.\n\nTax Compliance\n\nWe may collect tax identification information, such as TIN, where required by Nigerian tax laws. This data is shared with tax authorities as required by law.\n\nContent Ownership\n\nYou retain ownership of the content you upload. Our use of your content is governed by our Terms of Service. This Privacy Policy governs the personal data associated with your content, including your name and profile information."
 },
 {
  "heading": "18. DATA PROTECTION IMPACT ASSESSMENTS (DPIA)",
  "body": "We conduct DPIAs for high-risk processing activities, including large-scale processing of sensitive data, systematic monitoring, cross-border data transfers, and deployment of new technologies.\n\nDPIAs are conducted in accordance with Article 7(o) and 28 of the GAID."
 },
 {
  "heading": "19. RECORDS OF PROCESSING ACTIVITIES (ROPA)",
  "body": "We maintain comprehensive Records of Processing Activities in accordance with NDPA requirements, documenting categories of data subjects and personal data, purposes of processing, recipients of data, cross-border transfers, retention periods, and security measures."
 },
 {
  "heading": "20. GOVERNING LAW",
  "body": "This Privacy Policy is governed by the laws of the Federal Republic of Nigeria. Any disputes arising from this Policy shall be subject to the jurisdiction of Nigerian courts, without prejudice to your rights under applicable data protection laws.\n\nBy using WHO MADE THIS?, you acknowledge that you have read and understood this Privacy Policy."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'terms',
  $lgd$TERMS OF SERVICE$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "WHO MADE THIS?",
  "body": "TERMS OF SERVICE\n\nLast Updated: 26 October 2026\nEffective Date: 26 October 2026"
 },
 {
  "heading": "1. ACCEPTANCE OF TERMS",
  "body": "These Terms of Service (\"Terms\") constitute a legally binding agreement between you (\"User,\" \"you,\" or \"your\") and WAWU Technology Ltd (\"WAWU,\" \"we,\" \"us,\" or \"our\"), a company incorporated in Nigeria under the Companies and Allied Matters Act 2020.\n\nBy downloading, accessing, or using the WHO MADE THIS? (WMT) mobile application, website (wawuafrica.com), or related services (collectively, the \"Platform\"), you agree to be bound by these Terms. If you do not agree, you must not use the Platform.\n\nYou must be at least 18 years old to use the Platform. By using the Platform, you represent and warrant that you meet this requirement."
 },
 {
  "heading": "2. DEFINITIONS",
  "body": "Platform means the WMT app, website, and all related services.\n\nCreator means a User who uploads content or offers services for sale on the Platform.\n\nProfessional means a User who offers professional services or builds a professional profile.\n\nBuyer means a User who purchases content, products, or services on the Platform.\n\nContent means any material uploaded to the Platform, including music, designs, videos, photographs, written works, courses, and products.\n\nVerification means the paid identity verification process that unlocks monetization features.\n\nWallet means the in-app financial account for receiving and sending payments."
 },
 {
  "heading": "3. ELIGIBILITY",
  "body": "To use the Platform, you must be at least 18 years old, have the legal capacity to enter into binding contracts, not be barred from using the Platform under Nigerian law or any applicable jurisdiction, and provide accurate and complete registration information.\n\nWe reserve the right to refuse access to anyone at any time for any lawful reason."
 },
 {
  "heading": "4. ACCOUNT REGISTRATION AND SECURITY",
  "body": "You must create an account to access most features of the Platform. You agree to provide accurate, current, and complete information during registration and to update it as necessary.\n\nYou are responsible for maintaining the confidentiality of your login credentials. You must notify us immediately at support@wawuafrica.com if you suspect unauthorized access to your account.\n\nWe reserve the right to suspend or terminate your account if we suspect fraudulent activity, violation of these Terms, or any other breach."
 },
 {
  "heading": "5. VERIFICATION",
  "body": "Verification is optional but required to unlock selling, payments, and higher transaction limits. The verification fee is ₦2,000 per year, payable through the Platform.\n\nVerification is subject to identity checks, including submission of government-issued ID and biometric verification. We may use third-party verification partners.\n\nRefund Policy: Verification fees are non-refundable once the verification process has commenced. If verification is unsuccessful due to our error, we will refund the fee. If it is unsuccessful due to your failure to provide accurate information, no refund will be issued.\n\nAuto-Renewal: Verification is valid for one year from the date of successful verification. You will be notified before renewal. You may cancel renewal at any time in your account settings.\n\nEffect of Account Termination: If your account is terminated for violation of these Terms, your verification fee is non-refundable."
 },
 {
  "heading": "6. CONTENT OWNERSHIP AND LICENSE",
  "body": "You Retain Ownership: You retain all ownership rights to the Content you upload to the Platform. WAWU does not claim ownership of your Content.\n\nLicense to WAWU: By uploading Content, you grant WAWU a worldwide, non-exclusive, royalty-free, transferable license to host, store, display, reproduce, distribute, and promote your Content on the Platform and in connection with the Platform's marketing and promotional activities. This license terminates when you delete the Content or close your account, except for backup copies retained for legal or operational purposes.\n\nYour Responsibility: You represent and warrant that you own or have the necessary rights to upload the Content, that the Content does not infringe any third-party rights, and that the Content complies with applicable laws.\n\nProhibited Content: You may not upload Content that is unlawful, defamatory, obscene, hateful, infringing, or otherwise objectionable. We reserve the right to remove Content that violates these Terms."
 },
 {
  "heading": "7. MONETIZATION AND PAYMENTS",
  "body": "Selling: Verified Creators may sell Content, products, services, and courses on the Platform. You set your own prices.\n\nPlatform Fees: WAWU charges a commission on each sale. The current commission rate is displayed in your Creator Dashboard. We reserve the right to change the commission rate with 30 days' notice.\n\nPayouts: Funds from sales are credited to your Wallet after a clearing period (currently 7 days). You may request a payout to your linked bank account. Payouts are processed within standard banking timelines.\n\nTaxes: You are responsible for all taxes applicable to your sales. WAWU may collect tax identification information as required by law.\n\nRefunds: Buyers may request refunds in accordance with our Refund Policy. If a refund is issued, the corresponding amount will be deducted from your Wallet.\n\nChargebacks: If a Buyer initiates a chargeback, we may place a hold on your funds pending investigation. If the chargeback is upheld, the amount will be deducted from your Wallet."
 },
 {
  "heading": "8. REFUND POLICY",
  "body": "Digital Products: Digital products, including downloads and courses, are generally non-refundable once accessed, unless the product is defective or not as described.\n\nServices: Refunds for services are subject to the terms agreed between the Creator and the Buyer. WAWU may mediate disputes but is not obligated to issue refunds on behalf of Creators.\n\nVerification Fees: As set out in Section 5.\n\nDisputes: Buyers must raise disputes within 14 days of purchase. WAWU will review the dispute and make a determination in good faith."
 },
 {
  "heading": "9. ACCEPTABLE USE",
  "body": "You agree not to violate any applicable law or regulation, infringe the intellectual property rights of others, upload malware, viruses, or harmful code, engage in fraud, scams, or deceptive practices, harass, threaten, or abuse other Users, use the Platform to distribute spam or unsolicited communications, attempt to gain unauthorized access to the Platform or other Users' accounts, interfere with the operation of the Platform, use automated systems such as bots or scrapers without our written consent, or impersonate any person or entity.\n\nWe reserve the right to suspend or terminate your account for violations of this Section."
 },
 {
  "heading": "10. INTELLECTUAL PROPERTY",
  "body": "All intellectual property rights in the Platform, including the WAWU name, logo, trademarks, software, and design, are owned by WAWU or its licensors. You may not use our intellectual property without our prior written consent.\n\nThe WHO MADE THIS? name and logo are trademarks of WAWU Technology Ltd."
 },
 {
  "heading": "11. LIMITATION OF LIABILITY",
  "body": "To the maximum extent permitted by law, WAWU shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Platform. This includes loss of profits, loss of data, loss of goodwill, or business interruption.\n\nWAWU's total liability to you for any claim arising from these Terms or your use of the Platform shall not exceed the greater of the amount you paid to WAWU in the 12 months preceding the claim or ₦50,000.\n\nNothing in these Terms excludes or limits liability for fraud, death, or personal injury caused by negligence, or any other liability that cannot be excluded by law."
 },
 {
  "heading": "12. INDEMNITY",
  "body": "You agree to indemnify and hold harmless WAWU, its directors, officers, employees, and agents from any claims, losses, damages, liabilities, and expenses, including legal fees, arising from your use of the Platform, your Content, or your violation of these Terms."
 },
 {
  "heading": "13. TERMINATION",
  "body": "You may terminate your account at any time by deleting it in the app settings or by contacting support@wawuafrica.com.\n\nWe may suspend or terminate your account immediately if you violate these Terms, if required by law, or if we reasonably believe your account poses a risk to the Platform or other Users.\n\nUpon termination, your right to use the Platform ceases. Provisions that by their nature should survive termination, including ownership, indemnity, and limitation of liability, shall survive."
 },
 {
  "heading": "14. DISPUTE RESOLUTION",
  "body": "These Terms are governed by the laws of the Federal Republic of Nigeria.\n\nAny dispute arising from these Terms shall first be attempted to be resolved through good-faith negotiation. If negotiation fails, the dispute shall be referred to mediation in Lagos, Nigeria. If mediation fails, the dispute shall be subject to the exclusive jurisdiction of the courts of Lagos, Nigeria."
 },
 {
  "heading": "15. CHANGES TO TERMS",
  "body": "We may update these Terms from time to time. We will notify you of material changes via email or in-app notification at least 14 days before they take effect. Continued use of the Platform after changes constitutes acceptance."
 },
 {
  "heading": "16. GENERAL",
  "body": "Entire Agreement: These Terms, together with the Privacy Policy and any other policies referenced herein, constitute the entire agreement between you and WAWU.\n\nSeverability: If any provision is found invalid or unenforceable, the remaining provisions shall continue in effect.\n\nWaiver: Our failure to enforce any provision shall not constitute a waiver of that provision.\n\nAssignment: You may not assign your rights under these Terms without our written consent. We may assign our rights without restriction."
 },
 {
  "heading": "17. CONTACT",
  "body": "WAWU Technology Ltd\n5 Ikoyi Crescent, Lagos, Nigeria\n\nSupport: support@wawuafrica.com\nWhatsApp: +234 705 072 2222\nWeb: wawuafrica.com"
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'cookies',
  $lgd$COOKIE POLICY$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "1. WHAT ARE COOKIES?",
  "body": "Cookies are small text files stored on your device when you visit a website or use an app. They help us recognize your device, remember your preferences, and understand how you use the Platform."
 },
 {
  "heading": "2. TYPES OF COOKIES WE USE",
  "body": "Strictly Necessary Cookies: These are essential for the Platform to function. They enable core features such as account login, security, and session management. You cannot opt out of these cookies.\n\nAnalytics Cookies: These help us understand how Users interact with the Platform. We use this information to improve the Platform. These cookies collect aggregated, anonymized data. Examples include Google Analytics and Firebase Analytics.\n\nPreference Cookies: These remember your settings and preferences, such as language and display preferences.\n\nMarketing Cookies: These track your activity to deliver relevant advertising. We only use these with your consent. Examples include Meta Pixel and TikTok Pixel."
 },
 {
  "heading": "3. HOW TO MANAGE COOKIES",
  "body": "Browser Settings: You can manage cookies through your browser settings. Most browsers allow you to block or delete cookies. Note that blocking essential cookies may affect Platform functionality.\n\nApp Settings: You can manage tracking permissions through your device settings. On iOS, go to Settings, then Privacy, then Tracking. On Android, go to Settings, then Google, then Ads.\n\nOpt-Out Tools: You can opt out of certain analytics and marketing cookies through industry opt-out tools."
 },
 {
  "heading": "4. THIRD-PARTY COOKIES",
  "body": "Some cookies are placed by third parties, including analytics providers and advertising networks. We do not control these third-party cookies. Please review the privacy policies of these third parties for more information."
 },
 {
  "heading": "5. CHANGES TO THIS POLICY",
  "body": "We may update this Cookie Policy from time to time. Changes will be posted on this page with an updated \"Last Updated\" date."
 },
 {
  "heading": "6. CONTACT",
  "body": "For questions about this Cookie Policy, contact privacy@wawuafrica.com."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'creator-monetization',
  $lgd$CREATOR MONETIZATION AGREEMENT$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "CREATOR MONETIZATION AGREEMENT",
  "body": "This Creator Monetization Agreement (\"Agreement\") supplements the Terms of Service and applies to all Creators who monetize their Content on the WHO MADE THIS? Platform."
 },
 {
  "heading": "1. ELIGIBILITY",
  "body": "To monetize on the Platform, you must be a verified Creator, at least 18 years old, and in compliance with the Terms of Service."
 },
 {
  "heading": "2. COMMISSION AND FEES",
  "body": "WAWU charges a commission on each sale. The current commission rate is 15%. This rate is displayed in your Creator Dashboard and may be updated with 30 days' notice.\n\nPayment processing fees may apply and will be disclosed at the point of transaction."
 },
 {
  "heading": "3. PRICING",
  "body": "You set your own prices for your Content. You may change prices at any time. Prices must be displayed in the currency supported by the Platform, currently Nigerian Naira, with USD and other currencies available in supported regions."
 },
 {
  "heading": "4. PAYOUTS",
  "body": "Funds from sales are credited to your Wallet after a clearing period of 7 days. You may request a payout to your linked bank account at any time. Payouts are processed within standard banking timelines, typically 1 to 3 business days.\n\nThe minimum payout amount is ₦1,000."
 },
 {
  "heading": "5. REFUNDS AND CHARGEBACKS",
  "body": "If a Buyer is issued a refund, the corresponding amount, including WAWU's commission, will be deducted from your Wallet. If a Buyer initiates a chargeback, we may place a hold on your funds pending investigation."
 },
 {
  "heading": "6. TAXES",
  "body": "You are solely responsible for all taxes applicable to your sales, including income tax and VAT where applicable. WAWU may collect tax identification information, such as TIN, and may withhold taxes as required by Nigerian law."
 },
 {
  "heading": "7. CONTENT OWNERSHIP AND LICENSE",
  "body": "You retain ownership of your Content. You grant WAWU the license set out in the Terms of Service."
 },
 {
  "heading": "8. TERMINATION",
  "body": "If your account is terminated, your Content will be removed from the Platform. Pending payouts will be processed in accordance with these Terms, subject to any holds for disputes or chargebacks."
 },
 {
  "heading": "9. DISPUTE RESOLUTION",
  "body": "Disputes between Creators and Buyers should first be resolved directly. WAWU may mediate at its discretion. WAWU's decision on platform-related disputes is final."
 },
 {
  "heading": "10. CONTACT",
  "body": "For questions about monetization, contact creators@wawuafrica.com"
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'verification-refund',
  $lgd$VERIFICATION AND REFUND POLICY$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "1. VERIFICATION FEE",
  "body": "The minimum verification fee is ₦2,999 per year, payable through the Platform. This fee covers identity verification, fraud prevention, and access to monetization features."
 },
 {
  "heading": "2. WHAT VERIFICATION INCLUDES",
  "body": "Verification includes identity checks using government-issued ID, biometric verification through a liveness check, and screening against fraud and sanctions lists."
 },
 {
  "heading": "3. REFUNDS",
  "body": "Non-Refundable Once Commenced: Verification fees are non-refundable once the verification process has commenced.\n\nRefund for Our Error: If verification is unsuccessful due to our error, we will refund the fee in full.\n\nNo Refund for Your Error: If verification is unsuccessful due to your failure to provide accurate information or complete the process, no refund will be issued."
 },
 {
  "heading": "4. AUTO-RENEWAL",
  "body": "Verification is valid for one year. You will be notified before renewal. You may cancel renewal at any time in your account settings."
 },
 {
  "heading": "5. TERMINATION",
  "body": "If your account is terminated for violation of the Terms of Service, your verification fee is non-refundable."
 },
 {
  "heading": "6. CONTACT",
  "body": "For questions about verification, contact support@wawuafrica.com."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'acceptable-use',
  $lgd$ACCEPTABLE USE POLICY$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "1. PROHIBITED CONTENT",
  "body": "You may not upload, post, or share Content that is unlawful, defamatory, obscene, pornographic, or hateful, infringes the intellectual property rights of others, contains malware, viruses, or harmful code, is fraudulent or deceptive, harasses, threatens, or abuses others, or violates any applicable law or regulation."
 },
 {
  "heading": "2. PROHIBITED ACTIVITIES",
  "body": "You may not use the Platform for any unlawful purpose, engage in fraud, scams, or deceptive practices, impersonate any person or entity, attempt to gain unauthorized access to the Platform, interfere with the operation of the Platform, use automated systems such as bots or scrapers without our written consent, or distribute spam or unsolicited communications."
 },
 {
  "heading": "3. ENFORCEMENT",
  "body": "We reserve the right to remove Content that violates this Policy and to suspend or terminate the accounts of Users who violate it."
 },
 {
  "heading": "4. REPORTING",
  "body": "To report a violation, contact support@wawuafrica.com."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'partner-dpa',
  $lgd$DATA PROCESSING AGREEMENT (DPA) FOR PARTNERS$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "DATA PROCESSING AGREEMENT (DPA) FOR PARTNERS",
  "body": "This Data Processing Agreement (\"DPA\") applies where WAWU processes personal data on behalf of a Partner, or where a Partner processes personal data on behalf of WAWU."
 },
 {
  "heading": "1. DEFINITIONS",
  "body": "Terms used in this DPA have the meanings given in the Nigeria Data Protection Act 2023 (NDPA) and the UK GDPR where applicable."
 },
 {
  "heading": "2. ROLES",
  "body": "The Parties shall determine and document their respective roles as Data Controller and Data Processor for each processing activity."
 },
 {
  "heading": "3. PROCESSOR OBLIGATIONS",
  "body": "Where a Party acts as Data Processor, it shall process personal data only on the documented instructions of the Controller, implement appropriate technical and organizational security measures, assist the Controller in responding to data subject requests, notify the Controller of any personal data breach without undue delay, delete or return personal data at the end of the provision of services, and submit to audits and inspections as reasonably required."
 },
 {
  "heading": "4. CROSS-BORDER TRANSFERS",
  "body": "Any transfer of personal data outside Nigeria shall comply with Part VIII of the NDPA and Schedule 5 of the GAID."
 },
 {
  "heading": "5. LIABILITY",
  "body": "Each Party shall be liable for its own breaches of this DPA."
 },
 {
  "heading": "6. TERM",
  "body": "This DPA shall remain in effect for the duration of the partnership and shall survive termination to the extent necessary to comply with applicable law."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'community-guidelines',
  $lgd$COMMUNITY GUIDELINES$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "1. OUR COMMUNITY",
  "body": "WHO MADE THIS? is a place for creators and professionals to build, sell, and grow. We are committed to maintaining a safe, respectful, and inclusive environment."
 },
 {
  "heading": "2. EXPECTED BEHAVIOR",
  "body": "Treat others with respect. Be honest in your dealings. Respect intellectual property. Follow the law."
 },
 {
  "heading": "3. PROHIBITED BEHAVIOR",
  "body": "Harassment, hate speech, fraud, spam, and impersonation are not tolerated. Violations may result in suspension or termination."
 },
 {
  "heading": "4. REPORTING",
  "body": "To report a violation, contact support@wawuafrica.com."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";

INSERT INTO "LegalDocument" ("slug", "title", "effectiveDate", "sections", "updatedAt")
VALUES (
  'disclaimer',
  $lgd$DISCLAIMER$lgd$,
  DATE '2026-10-26',
  $lgd$[
 {
  "heading": "1. GENERAL INFORMATION",
  "body": "The content on the Platform is for general information and use. It is not intended as professional advice."
 },
 {
  "heading": "2. NO WARRANTY",
  "body": "The Platform is provided \"as is\" and \"as available.\" We do not warrant that the Platform will be uninterrupted, error-free, or free of viruses."
 },
 {
  "heading": "3. THIRD-PARTY LINKS",
  "body": "The Platform may contain links to third-party websites. We are not responsible for the content or practices of those websites."
 },
 {
  "heading": "4. LIMITATION OF LIABILITY",
  "body": "To the maximum extent permitted by law, WAWU shall not be liable for any damages arising from your use of the Platform."
 }
]$lgd$::jsonb,
  TIMESTAMP '2026-10-26 12:00:00.000'
)
ON CONFLICT ("slug") DO UPDATE SET
  "title" = EXCLUDED."title",
  "effectiveDate" = EXCLUDED."effectiveDate",
  "sections" = EXCLUDED."sections",
  "updatedAt" = EXCLUDED."updatedAt";
