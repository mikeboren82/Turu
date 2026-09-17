-- 0098 - the 9-region split (0084) reaches VENUES and SOURCES (2026-09-17).
-- 0084 split locations.region; venues (whose CHECK still enforced the old 7 names) and sources kept the two
-- combined names, so coverage by region showed 0 sources / venues for the North, the Valleys, the Shfela and
-- the South. Every new value below was derived from canonical knowledge (generate-region-split-migration.js):
-- venue city -> canonical settlement -> region; source -> its venue, else the dominant region of its own activities.
-- venues re-mapped: 25 | sources re-mapped: 61
-- NOT decidable, set to NULL for a person to assign - venues (2): סנטר הגליל (no city; settlement region unresolved) ; בית ספר שדה גולן (גולן; settlement region unresolved)
-- NOT decidable, set to NULL - sources (4): אמות קניונים - סנטר הגליל ; מועצה אזורית חבל מודיעין - אירועים ; תיאטרון ילדים - הצגות באשקלון (אגרגטור) ; iShow - פעילויות לילדים בדרום (אגרגטור)
-- Order matters (incident 2026-09-13): drop the CHECK, update, re-add it - in ONE transaction.
begin;
alter table public.venues drop constraint if exists venues_region_check;
update public.venues set region = 'הדרום והנגב' where id = 'ed1418f3-d2f6-4774-8af6-28d76f050950' and region = 'השפלה והדרום'; -- גרנד קניון באר שבע (באר שבע)
update public.venues set region = 'הדרום והנגב' where id = 'db318947-6188-4328-b258-a93c2ef5d26c' and region = 'השפלה והדרום'; -- אמות נווה זאב (באר שבע)
update public.venues set region = 'הדרום והנגב' where id = 'b9aa2678-cf6c-4811-90d3-46565bac2c60' and region = 'השפלה והדרום'; -- אמות באר שבע (B7) (באר שבע)
update public.venues set region = 'הצפון והגליל' where id = 'a490de2f-a1de-43a0-990c-47f96eeecd61' and region = 'הצפון והעמק'; -- מיי סנטר כרמיאל (כרמיאל)
update public.venues set region = 'הדרום והנגב' where id = '75a77510-f4e8-44b4-bc38-22d6885d8790' and region = 'השפלה והדרום'; -- עזריאלי הנגב (באר שבע)
update public.venues set region = 'הדרום והנגב' where id = '5743e2ee-716f-47bb-b04a-aed59821f536' and region = 'השפלה והדרום'; -- מדבריום (מצפה רמון)
update public.venues set region = 'השפלה' where id = '300aa808-d357-47d6-bf43-ab9a309af0d2' and region = 'השפלה והדרום'; -- גן המדע מכון דוידסון (רחובות)
update public.venues set region = 'הצפון והגליל' where id = 'f749ebe5-da97-46bf-b565-e37c6d345f04' and region = 'הצפון והעמק'; -- היכל התרבות כרמיאל (כרמיאל)
update public.venues set region = 'הדרום והנגב' where id = '91ecf19d-5df0-45e1-ac28-75a7e60bb5d7' and region = 'השפלה והדרום'; -- קניון גירון אשקלון (אשקלון)
update public.venues set region = 'הצפון והגליל' where id = 'a7a4282f-04ba-49b7-8d38-b3d1d7d7c687' and region = 'הצפון והעמק'; -- ביג פאשן נצרת (נצרת)
update public.venues set region = 'השפלה' where id = 'd322406c-59b3-44aa-b14e-1b8f982a3b88' and region = 'השפלה והדרום'; -- היכל התרבות לוד (לוד)
update public.venues set region = 'הדרום והנגב' where id = '3b8f16e7-c888-4011-a5ed-42ae02dcb046' and region = 'השפלה והדרום'; -- המשכן לאמנויות הבמה באר שבע (באר שבע)
update public.venues set region = 'השפלה' where id = 'b1a0d189-62b8-4b50-bd2d-93b9cf46af96' and region = 'השפלה והדרום'; -- כותר - הספרייה העירונית יבנה (יבנה)
update public.venues set region = 'הדרום והנגב' where id = '49650283-471e-4c94-8f66-441246e66aa8' and region = 'השפלה והדרום'; -- היכל התרבות קריית גת (קריית גת)
update public.venues set region = 'הדרום והנגב' where id = '6231bf1f-8538-42df-9ec4-7984c67893b8' and region = 'השפלה והדרום'; -- בית רחל וישראל פולק (קריית גת)
update public.venues set region = 'השפלה' where id = 'aa6c5dc0-d0c6-4d22-8835-d8d461bc0533' and region = 'השפלה והדרום'; -- קניון סי מול אשדוד (אשדוד)
update public.venues set region = 'הדרום והנגב' where id = '0ec1d4c9-301e-450e-80ad-e8fa2a17299b' and region = 'השפלה והדרום'; -- היכל התרבות אשקלון (אשקלון)
update public.venues set region = 'השפלה' where id = '6ee7e26c-c220-47ca-9153-346cdaab67cb' and region = 'השפלה והדרום'; -- היכל התרבות יבנה (יבנה)
update public.venues set region = 'הצפון והגליל' where id = 'cb431f40-2006-466e-bf79-97a779ae1cbf' and region = 'הצפון והעמק'; -- קניון בירוקה קריית שמונה (קריית שמונה)
update public.venues set region = 'השפלה' where id = 'f0b18e40-0f9a-4ea9-b94d-5e74ab0d3449' and region = 'השפלה והדרום'; -- אשכול הפיס בית חשמונאי (בית חשמונאי)
update public.venues set region = 'הצפון והגליל' where id = 'e8f92bbc-3bb4-4d02-8e5c-dcf4fe5a894b' and region = 'הצפון והעמק'; -- היכל התרבות עכו (עכו)
update public.venues set region = 'הדרום והנגב' where id = '6c76ca2b-30f6-4a80-95c6-cdc30916d99c' and region = 'השפלה והדרום'; -- ג׳ימבורי בית רחל (קריית גת)
update public.venues set region = 'השפלה' where id = '67fe1cc2-318e-430a-ae25-43da972cdadf' and region = 'השפלה והדרום'; -- הבית למשפחות מיוחדות (רחובות)
update public.venues set region = 'השפלה' where id = '625acb44-3cb6-482c-b678-66f6b2001865' and region = 'השפלה והדרום'; -- חוויות שוויץ רחובות החדשה (רחובות)
update public.venues set region = 'הצפון והגליל' where id = '1d8b0369-a848-4a30-bcaa-e03cf77deea0' and region = 'הצפון והעמק'; -- מרכז קהילתי גרין (נוף הגליל)
update public.venues set region = null where region in ('השפלה והדרום', 'הצפון והעמק');
alter table public.venues add constraint venues_region_check check (region is null or region in ('גוש דן והמרכז', 'השרון', 'ירושלים והסביבה', 'חיפה והקריות', 'הצפון והגליל', 'עמק יזרעאל והעמקים', 'השפלה', 'הדרום והנגב', 'יו"ש והבנימין'));
update public.sources set region = 'הצפון והגליל' where id = '2a8738aa-cda2-42ef-94b8-5d352b9912fe' and region = 'הצפון והעמק'; -- היכל התרבות עכו [venue]
update public.sources set region = 'השפלה' where id = '121a9a38-64eb-49c2-8867-676300df4eb8' and region = 'השפלה והדרום'; -- גן המדע מכון דוידסון - רחובות [venue]
update public.sources set region = 'השפלה' where id = '20630621-f1cb-47bf-82eb-6e8e58ba180f' and region = 'השפלה והדרום'; -- רשת המתנ"סים יבנה [settlement in the name: יבנה]
update public.sources set region = 'הדרום והנגב' where id = '463a60f6-e3fb-42cf-81d2-50de338b35d3' and region = 'השפלה והדרום'; -- עזריאלי הנגב באר שבע - אירועים [venue]
update public.sources set region = 'הצפון והגליל' where id = '6015b6cd-d903-4a6c-a70d-d6326e5bf709' and region = 'הצפון והעמק'; -- רשת מתנ"סים נהריה - לוח אירועים [settlement in the name: נהריה]
update public.sources set region = 'השפלה' where id = '6f302b39-4d9b-4b3b-bbfe-a3d9946c3235' and region = 'השפלה והדרום'; -- החברה העירונית אשדוד - לוח אירועים [settlement in the name: אשדוד]
update public.sources set region = 'השפלה' where id = '54ed5cf9-d121-440c-828b-8f63e1378a1d' and region = 'השפלה והדרום'; -- מתנ"ס גן יבנה - פעילויות [settlement in the name: גן יבנה]
update public.sources set region = 'הצפון והגליל' where id = 'f7fb844a-2fe4-4a12-9cd6-6f84c644e237' and region = 'הצפון והעמק'; -- עיריית נהריה מחלקת תרבות - פייסבוק [settlement in the name: נהריה]
update public.sources set region = 'הצפון והגליל' where id = '4cdab782-165b-4915-9f4d-b26625197fcd' and region = 'הצפון והעמק'; -- עיריית כרמיאל - מינהלת התרבות [settlement in the name: כרמיאל]
update public.sources set region = 'הדרום והנגב' where id = 'c55a8feb-f08d-4746-a0ea-82e928133cc1' and region = 'השפלה והדרום'; -- אמות קניונים - נווה זאב באר שבע [venue]
update public.sources set region = 'הדרום והנגב' where id = 'c3b597d8-708b-407f-85c0-0703aeddd961' and region = 'השפלה והדרום'; -- עיריית באר שבע - אירועים [settlement in the name: באר שבע]
update public.sources set region = 'הצפון והגליל' where id = '00e6653d-d176-48a3-9930-e5d7495b17c6' and region = 'הצפון והעמק'; -- עיריית נוף הגליל [settlement in the name: נוף הגליל]
update public.sources set region = 'השפלה' where id = '8265ae56-ee2a-4c65-9bb9-9e91e0d235b0' and region = 'השפלה והדרום'; -- רשת ספריות חוויות רחובות [activities 8/8]
update public.sources set region = 'הדרום והנגב' where id = 'ea23123d-0ffe-4c83-8978-a7f22f3a2d62' and region = 'השפלה והדרום'; -- מדבריום - פארק חיות מדבר [venue]
update public.sources set region = 'הדרום והנגב' where id = '393bc9ee-09dc-4a1a-86f2-9a4d4a1283a4' and region = 'השפלה והדרום'; -- היכל התרבות אשקלון [venue]
update public.sources set region = 'הצפון והגליל' where id = '8ce76b4c-3ed7-4e06-9de0-a96fef0c375f' and region = 'הצפון והעמק'; -- רשת המתנ"סים כרמיאל [activities 4/4]
update public.sources set region = 'הדרום והנגב' where id = '448387ae-fba0-4cce-89b2-6f50397ca0ad' and region = 'השפלה והדרום'; -- החברה העירונית קריית גת (כרטיסים) [settlement in the name: קריית גת]
update public.sources set region = 'השפלה' where id = 'af8824e3-2e32-483a-87b6-de857c49d549' and region = 'השפלה והדרום'; -- תיירות אשדוד - אירועים [activities 31/39]
update public.sources set region = 'הצפון והגליל' where id = 'f4b3610c-23f4-4a9f-9746-e5c6ee9c495f' and region = 'הצפון והעמק'; -- עיריית נהריה [settlement in the name: נהריה]
update public.sources set region = 'עמק יזרעאל והעמקים' where id = '4daf554f-2c60-4545-a1f9-adc650683fdb' and region = 'הצפון והעמק'; -- עיריית עפולה [settlement in the name: עפולה]
update public.sources set region = 'הצפון והגליל' where id = '8a96e654-5efe-47ec-8592-a86d08d3577a' and region = 'הצפון והעמק'; -- BIG FASHION נצרת (bigcenters.co.il) [venue]
update public.sources set region = 'הצפון והגליל' where id = 'ff0d1d1c-ba41-4805-9c04-a3d861f98c5a' and region = 'הצפון והעמק'; -- עיריית נהריה [settlement in the name: נהריה]
update public.sources set region = 'הצפון והגליל' where id = '627f3c65-1bd2-4792-bbcb-5461e2dca094' and region = 'הצפון והעמק'; -- היכל התרבות כרמיאל [venue]
update public.sources set region = 'הדרום והנגב' where id = '93c52fc9-ae2c-4c60-8045-1db01a7df88a' and region = 'השפלה והדרום'; -- עיריית אשקלון - כל האירועים [settlement in the name: אשקלון]
update public.sources set region = 'הדרום והנגב' where id = '07761f72-8cf8-4623-9388-b8a8f9b0278c' and region = 'השפלה והדרום'; -- אמות קניונים - אמות באר שבע B7 [venue]
update public.sources set region = 'הדרום והנגב' where id = 'f62615c4-253d-4c50-bd19-8c4fc649fc77' and region = 'השפלה והדרום'; -- עיריית אילת [settlement in the name: אילת]
update public.sources set region = 'הדרום והנגב' where id = 'a3e8873c-5a63-4f65-b061-c521094aa80a' and region = 'השפלה והדרום'; -- גרנד קניון באר שבע - פייסבוק [venue]
update public.sources set region = 'השפלה' where id = '15493d96-133e-4053-b6e7-af9ee418b967' and region = 'השפלה והדרום'; -- עיריית יבנה [settlement in the name: יבנה]
update public.sources set region = 'עמק יזרעאל והעמקים' where id = 'd2f1b2cf-c40c-4ff1-a41d-ccd0f29c72a4' and region = 'הצפון והעמק'; -- עיריית טבריה [settlement in the name: טבריה]
update public.sources set region = 'הדרום והנגב' where id = '13bab2f9-e2b8-48e2-b631-f06efb4d6638' and region = 'השפלה והדרום'; -- מבלים - המשכן לאמנויות הבמה באר שבע (אגרגטור) [venue]
update public.sources set region = 'הצפון והגליל' where id = '7157effd-b677-470d-bdd0-bb9bbfc27e39' and region = 'הצפון והעמק'; -- עיריית נצרת [settlement in the name: נצרת]
update public.sources set region = 'השפלה' where id = 'acf4b86b-cb27-4e16-8225-187e6786666c' and region = 'השפלה והדרום'; -- תרבות אשדוד - ילדים [settlement in the name: אשדוד]
update public.sources set region = 'השפלה' where id = 'd063976d-52bb-4a53-9b8e-b3261b8d37ff' and region = 'השפלה והדרום'; -- עיריית אשדוד [settlement in the name: אשדוד]
update public.sources set region = 'הדרום והנגב' where id = '435a2a0e-f0e0-4ffd-862e-b437d2085c4e' and region = 'השפלה והדרום'; -- קניון גירון אשקלון - פייסבוק [venue]
update public.sources set region = 'הדרום והנגב' where id = '6c979f97-dd41-4080-9394-ff6554262f28' and region = 'השפלה והדרום'; -- החברה העירונית אשקלון - אירועים [settlement in the name: אשקלון]
update public.sources set region = 'הצפון והגליל' where id = 'e2d24d98-ca91-4505-933d-f6a28a491899' and region = 'הצפון והעמק'; -- אמות קניונים - מיי סנטר כרמיאל [venue]
update public.sources set region = 'הצפון והגליל' where id = 'e5b97c4c-0ddd-4a4b-a105-6f4ce0abc4d0' and region = 'הצפון והעמק'; -- ביג פאשן נצרת - אינסטגרם [venue]
update public.sources set region = 'השפלה' where id = '8b647aaf-0d1d-421c-ae33-d3d4d2cd35ca' and region = 'השפלה והדרום'; -- עיריית מודיעין מכבים רעות - לוח אירועים [settlement in the name: מודיעין מכבים רעות]
update public.sources set region = 'הצפון והגליל' where id = '9e8bf486-9dec-4a14-ab23-0b16d7b13fc3' and region = 'הצפון והעמק'; -- החברה למרכזים קהילתיים צפת [settlement in the name: צפת]
update public.sources set region = 'הדרום והנגב' where id = '16d281d0-070a-4c83-a02c-424690ae7d86' and region = 'השפלה והדרום'; -- כיוונים באר שבע - אירועים ומופעים (רשת מרכזים קהילתיים) [activities 7/7]
update public.sources set region = 'הצפון והגליל' where id = '121f1d3a-647b-48b1-b2ce-34bf396efd16' and region = 'הצפון והעמק'; -- הספרייה העירונית כרמיאל [settlement in the name: כרמיאל]
update public.sources set region = 'השפלה' where id = '31cb5b2e-c7b8-4e4e-9e89-704818013e1a' and region = 'השפלה והדרום'; -- מועצה אזורית גזר - אירועי ילדים [activities 6/6]
update public.sources set region = 'הדרום והנגב' where id = 'c6c748af-3c67-4a57-ba95-bc0dd9eca162' and region = 'השפלה והדרום'; -- מדבריום - אינסטגרם [venue]
update public.sources set region = 'הצפון והגליל' where id = '330be6ac-5976-44c6-b75b-ed0c923c48cc' and region = 'הצפון והעמק'; -- עיריית עכו [settlement in the name: עכו]
update public.sources set region = 'השפלה' where id = '68a12de4-876d-4df4-bc51-e90d594a9aa6' and region = 'השפלה והדרום'; -- עיריית לוד [activities 12/12]
update public.sources set region = 'השפלה' where id = '3a082dd2-cd05-4e3f-8bf5-66c3e015fd16' and region = 'השפלה והדרום'; -- תרבות אשדוד - אגף אירועים [settlement in the name: אשדוד]
update public.sources set region = 'הצפון והגליל' where id = '7254d4d5-05cc-46e6-9e6d-58231e9a894e' and region = 'הצפון והעמק'; -- זהר הצפון - לוח אירועים כרמיאל משגב (מקומון) [settlement in the name: כרמיאל]
update public.sources set region = 'השפלה' where id = '478db2aa-0944-441e-8a30-186aef0e2bde' and region = 'השפלה והדרום'; -- רשת המתנ"סים קריית גת - אירועים [activities 43/43]
update public.sources set region = 'הצפון והגליל' where id = 'a77308bd-449e-4c58-aabe-2a3406c6e78c' and region = 'הצפון והעמק'; -- עיריית צפת [settlement in the name: צפת]
update public.sources set region = 'הדרום והנגב' where id = 'bdbf3876-5714-40f7-8fba-c11d6eb27c6c' and region = 'השפלה והדרום'; -- עיריית קריית גת [settlement in the name: קריית גת]
update public.sources set region = 'השפלה' where id = '5fac1167-e6a8-4a7f-9a91-7a14d4574eec' and region = 'השפלה והדרום'; -- גן המדע מכון דוידסון - פייסבוק [venue]
update public.sources set region = 'הצפון והגליל' where id = 'debc52cc-dc7f-40fd-a981-1935f415cc45' and region = 'הצפון והעמק'; -- נוף הגליל - רשת המרכזים הקהילתיים פסיפס [activities 9/9]
update public.sources set region = 'השפלה' where id = 'cd1ac7f1-bfcf-4b8e-80ce-2861f20a70e3' and region = 'השפלה והדרום'; -- קניון סי מול אשדוד - אירועים [venue]
update public.sources set region = 'השפלה' where id = '94a7c1b1-d293-4a04-9406-aeab7cca48c3' and region = 'השפלה והדרום'; -- גן המדע מכון דוידסון - אינסטגרם [venue]
update public.sources set region = 'הדרום והנגב' where id = '3393585a-0556-452d-b18e-494ee11a4604' and region = 'השפלה והדרום'; -- קופת בראבו - היכל התרבות אשקלון (כרטיסים) [venue]
update public.sources set region = 'השפלה' where id = '0d1e5c8d-c21e-4e0e-8464-8ac02747c57c' and region = 'השפלה והדרום'; -- חמש שוהם - לוח אירועים [settlement in the name: שוהם]
update public.sources set region = 'הצפון והגליל' where id = '902dad01-2b5c-4719-8b5b-464a03cc79ef' and region = 'הצפון והעמק'; -- עיריית קריית שמונה [settlement in the name: קריית שמונה]
update public.sources set region = 'השפלה' where id = '6eefd3b9-18fe-4a69-881c-b8b54cd1e228' and region = 'השפלה והדרום'; -- רשת המתנ"סים יבנה - פייסבוק [settlement in the name: יבנה]
update public.sources set region = 'השפלה' where id = 'e6441fe4-bced-4beb-beff-4a31c196945e' and region = 'השפלה והדרום'; -- החברה העירונית לתרבות ופנאי אשדוד - אינסטגרם [settlement in the name: אשדוד]
update public.sources set region = 'השפלה' where id = '99d1ac05-bf57-4d20-b373-2ef63be7b515' and region = 'השפלה והדרום'; -- רשת המתנ"סים יבנה - אינסטגרם [settlement in the name: יבנה]
update public.sources set region = 'השפלה' where id = '2eb39810-4570-43fc-a3fb-fb7d0a06cb10' and region = 'השפלה והדרום'; -- החברה העירונית לתרבות ופנאי אשדוד - פייסבוק [settlement in the name: אשדוד]
update public.sources set region = null where region in ('השפלה והדרום', 'הצפון והעמק');
commit;
