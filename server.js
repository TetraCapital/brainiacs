const http = require('http');
const fs_mod = require('fs');
const path_mod = require('path');
const crypto = require('crypto');

// ── DATABASE (PostgreSQL via pg) ───────────────────────────────────────────
// Set DATABASE_URL env var to enable. Falls back gracefully if not present.
let db = null;
(function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[db] No DATABASE_URL — running in localStorage-only mode');
    return;
  }
  try {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    db.query(`CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW()
      )`)
      .then(function() {
        return db.query(`CREATE TABLE IF NOT EXISTS game_results (
          id SERIAL PRIMARY KEY,
          player_id TEXT NOT NULL REFERENCES players(id),
          game TEXT NOT NULL,
          played INT NOT NULL DEFAULT 0,
          wins INT NOT NULL DEFAULT 0,
          current_streak INT NOT NULL DEFAULT 0,
          max_streak INT NOT NULL DEFAULT 0,
          total_guesses_on_win INT NOT NULL DEFAULT 0,
          distribution JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(player_id, game)
        )`);
      })
      .then(function() { console.log('[db] Schema ready'); })
      .catch(function(e) { console.error('[db] Schema error:', e.message); });
  } catch(e) {
    console.log('[db] pg module not available:', e.message);
    db = null;
  }
})();

// ── COOKIE / UID HELPERS ───────────────────────────────────────────────────
function parseCookies(req) {
  var list = {}, rc = req.headers.cookie;
  if (rc) rc.split(';').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    list[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return list;
}

function getOrCreateUID(req, res) {
  var cookies = parseCookies(req);
  var uid = cookies['bn_uid'];
  if (!uid) {
    uid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    // Not HttpOnly so client JS can read it for "You" highlighting in rankings
    res.setHeader('Set-Cookie', 'bn_uid=' + uid + '; Path=/; Max-Age=31536000; SameSite=Lax');
  }
  return uid;
}

function readJSON(req) {
  return new Promise(function(resolve, reject) {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); if (body.length > 1e5) req.destroy(); });
    req.on('end', function() { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── INFLECTION FILTER ──
// Removes obvious plurals, 3rd-person -s/-es, and -ed past tenses from an answer pool.
// The full word list is still used for guess validation; only answers are filtered.
function filterAnswerWords(words) {
  return words.filter(w => {
    // Drop all words ending in -s unless they end in -ss (e.g. keep brass, dress, cross)
    if (w.endsWith('s') && !w.endsWith('ss')) return false;
    return true;
  });
}

// ── WORD LIST LOADER ─────────────────────────────────────────────────────────
// Source: wordlist.txt in the same directory as server.js
// Each game filters by length: Wordle/Blindle=5, Pathle=4-5, FastSpell=4-8
// Replace wordlist.txt and restart to change the dictionary for ALL games.
let WL_ALL   = null;  // all valid alpha words from wordlist.txt
let WL_5     = null;  // exactly 5-letter words  → Wordle + Blindle answers/valid
let WL_5_ANSWERS = null; // WL_5 minus inflected forms  → answer pool for Wordle/Blindle/Pathle
let WL_FR_ALL = null; // French word list (all lengths)
let WL_FR_5   = null; // French 5-letter words
let WL_FR_5_ANSWERS = null; // French 5-letter answers (no inflections)
let WL_FR_FS  = null; // French 4-8 letter words for FastSpell
let WL_FS    = null;  // 4-8 letter words         → FastSpell
(function loadWordlist() {
  const wlPath = path_mod.join(__dirname, 'wordlist.txt');
  try {
    const raw = fs_mod.readFileSync(wlPath, 'utf8');
    WL_ALL = raw.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => /^[a-z]+$/.test(w));
    WL_5   = WL_ALL.filter(w => w.length === 5);
    WL_FS  = WL_ALL.filter(w => w.length >= 4 && w.length <= 8);
    console.log('[wordlist] Loaded ' + WL_ALL.length + ' words | 5-letter: ' + WL_5.length + ' | FastSpell(4-8): ' + WL_FS.length);
    WL_5_ANSWERS = filterAnswerWords(WL_5);
    console.log('[wordlist] 5-letter answer pool (no inflections): ' + WL_5_ANSWERS.length);
    // ── FRENCH WORD LIST ──
    try {
      const frPath = path_mod.join(__dirname, 'wordlist_fr.txt');
      const frRaw = require('fs').readFileSync(frPath, 'utf8');
      WL_FR_ALL = frRaw.split(/\r?\n/).map(w=>w.trim().toLowerCase()).filter(w=>/^[a-záàâäéèêëîïôùûüç]+$/.test(w));
      WL_FR_5   = WL_FR_ALL.filter(w=>w.length===5);
      WL_FR_5_ANSWERS = filterAnswerWords(WL_FR_5);
      WL_FR_FS  = WL_FR_ALL.filter(w=>w.length>=4&&w.length<=8);
      console.log('[wordlist] French: '+WL_FR_ALL.length+' words | 5-letter: '+WL_FR_5.length);
    } catch(e) {
      console.log('[wordlist] wordlist_fr.txt not found — using built-in French fallback');
    }
  } catch(e) {
    console.log('[wordlist] wordlist.txt not found — using built-in fallback lists');
  }
})();

ttp = require('http');

// ── WORD LIST LOADER ─────────────────────────────────────────────────────────
// Reads wordlist.txt from the same directory as server.js (if it exists).
// Filter bands: 4-8 letters for FastSpell, 5 letters for Wordle/Blindle.
// To change the source, replace wordlist.txt in the same folder and restart.
let EXT_WORDS_FS = null;   // 4-8 letter words for FastSpell
(function loadWordlist() {
  const wlPath = path_mod.join(__dirname, 'wordlist.txt');
  try {
    const raw = fs_mod.readFileSync(wlPath, 'utf8');
    const all = raw.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => /^[a-z]+$/.test(w));
    EXT_WORDS_FS = all.filter(w => w.length >= 4 && w.length <= 8);
    console.log('[wordlist] Loaded ' + all.length + ' words total, ' + EXT_WORDS_FS.length + ' valid for FastSpell (4-8 letters)');
  } catch(e) {
    console.log('[wordlist] wordlist.txt not found — using built-in word list');
  }
})();

const FALLBACK_PW = ['aahed','aalii','abaci','aback','abaft','abase','abash','abate','abbey','abbot','abhor','abide','abled','abler','abode','abort','about','above','abuse','abuzz','abyes','abysm','abyss','ached','acids','acing','acmes','acned','acorn','acres','acrid','acted','actin','acute','adage','added','adder','addle','adept','admit','adobe','adopt','adore','adorn','adult','adust','aegis','aeons','affix','afire','afoot','afore','afoul','after','again','agate','agave','agaze','agent','agile','aging','agios','agism','aglow','agone','agony','agora','agree','agued','ahead','ahull','aided','aider','aides','aimed','aimer','aioli','aired','airly','airts','aisle','aitch','alarm','album','alder','alert','algae','algal','algid','alien','align','alike','alive','allay','alley','allot','allow','aloft','alone','along','aloof','aloud','alter','altho','alway','amass','amaze','amber','ambit','amble','amend','amine','amiss','among','ample','amuse','anear','angel','anger','angry','angst','anime','ankle','annex','annoy','antic','anvil','apart','aphid','aphis','apish','apple','apply','apron','arbor','arced','ardor','arena','argon','argot','argue','ariel','arise','arity','arles','armed','armet','armor','aroma','arose','array','arrow','arson','artsy','ascot','ashen','ashes','aside','aspen','asset','atilt','atoll','atone','attic','audio','audit','augur','avail','avert','avian','avoid','await','awake','award','aware','awash','awful','awoke','axiom','axion','azide','azote','azure','babel','babka','badge','badly','bagel','baggy','baize','baked','baker','balky','balls','balmy','banal','bandy','banjo','basal','based','basic','basis','baste','batch','batty','bayou','beach','beady','beard','beast','bedim','beefy','befit','began','begin','begot','beige','being','belay','belie','belle','belly','below','bench','bevel','bezel','bight','bigot','biome','birch','birdy','birth','bitty','black','blade','blame','bland','blank','blare','blast','blaze','bleah','bleat','bleed','bleep','blend','bless','blimp','blind','bling','blink','bliss','bloat','block','bloke','blond','blood','bloom','bloop','blots','blown','blues','bluey','blunt','blurb','blurr','blurt','board','bobby','boded','bogey','boggy','bogie','bogus','boils','bolts','bonds','bones','boney','bonny','bonus','books','boons','boost','booth','booty','booze','boozy','borax','borer','borne','bossy','botch','bough','boule','bound','bowed','bower','boxer','brace','braid','brain','brand','brash','brave','brawl','brawn','brays','braze','bread','break','bream','breed','bribe','brick','bride','brief','brine','bring','briny','brisk','broad','broil','broke','brood','brook','broth','brown','brush','brute','budge','buggy','build','built','bulge','bully','bumph','bumpy','bunny','burly','burns','burps','burro','burrs','burry','burst','bushy','butch','butte','butts','buzzy','byway','cabal','cabin','cache','cadge','caged','cagey','calve','camel','cameo','campy','candy','canoe','carat','cargo','carry','carte','carve','caste','catch','cause','cedar','chafe','chain','chair','champ','chant','chaos','charm','chart','chary','chase','chasm','cheap','cheat','check','cheek','chest','chewy','chide','chief','child','chili','chimp','chips','chirp','chive','choir','chomp','chops','chord','chore','chose','chuck','chunk','churn','cigar','cinch','civic','civil','clack','clads','claim','clamp','clang','clank','clash','clasp','class','clean','clear','cleat','cleft','clerk','click','cliff','climb','cling','clink','cloak','clock','clogs','clomp','clone','clops','close','cloth','cloud','clout','clump','clung','clunk','coals','coast','coils','color','comet','comfy','comic','conch','coral','cords','corer','corgi','corny','couch','could','count','coupe','court','cover','covet','craft','cramp','crane','crank','crash','crass','craze','creak','cream','crept','crest','crick','cries','crime','crimp','crisp','croak','croft','crone','croon','crops','cross','crowd','crown','crumb','crush','crust','crypt','cumin','cunny','cupid','cured','cures','curry','curve','curvy','cushy','cutie','cycle','czars','daffy','daily','dally','dance','datum','daunt','dazed','dealt','death','debar','debut','decal','decoy','decry','delay','delta','delve','demon','demur','dense','depot','depth','derby','devil','digit','dingo','dingy','dirge','dirty','disco','ditch','diver','divvy','dizzy','dodge','dodgy','dolly','dopey','dotty','doubt','dough','dowdy','dower','downy','dowry','draft','drain','drama','drank','drape','drawl','dread','dream','drear','dress','dribs','dried','drift','drink','drive','drone','drool','droop','drops','drove','drown','drubs','drugs','drums','drunk','drupe','druse','duchy','dumpy','dunce','durra','duvet','dwarf','dwelt','dying','eager','eagle','early','earth','ebony','eclat','edged','edify','egret','eight','eject','eking','elbow','elder','elegy','elfin','elite','elude','email','ember','emcee','emery','emote','empty','enact','endow','enjoy','enter','entry','epoch','equal','equip','error','essay','ethos','ethyl','etude','evade','event','every','evoke','exact','exalt','excel','exert','exist','expel','extol','extra','exude','fable','faced','fagot','faint','faith','faker','false','famed','fancy','fangs','farce','fatal','fault','feast','feign','felon','fence','ferny','fetid','fever','fewer','fiber','field','fiend','fifth','fifty','fight','filed','filet','filmy','final','finch','fired','fires','first','fixed','fixer','fizzy','flabs','flack','flags','flail','flair','flaky','flame','flank','flare','flash','flask','flawy','flays','fleam','fleet','flesh','flews','flick','flier','fling','flint','flips','flirt','flits','floam','float','flock','flocs','floes','flogs','flood','floor','flops','flora','floss','flour','flout','flown','flubs','fluff','fluid','fluke','flunk','flush','flute','foamy','foggy','foils','folly','foray','force','forge','forth','forum','found','foyer','frail','frame','frank','fraud','freak','fresh','frill','frisk','frizz','frond','front','frore','frost','froth','froze','frozy','fruit','frump','fugue','fully','funky','funny','fuzzy','gable','gamer','ganef','gaudy','gauze','gauzy','gavel','gawky','gecko','ghost','giant','giddy','giffy','gilet','gimpy','girly','given','gland','glare','glass','gleam','glide','glint','gloat','globe','glogg','gloom','glops','glory','gloss','glove','glows','glued','glues','glyph','gnash','godly','going','golem','golly','goner','gooey','goofy','gouge','gouty','grabs','grace','grade','graft','grant','grape','graph','grasp','grass','gravy','graze','great','greed','green','greet','grief','grimy','grind','gripe','groan','groin','grope','gross','group','grove','growl','grown','grubs','gruel','gruff','grump','grunt','guard','guava','guess','guest','guide','guild','guile','guilt','guise','gulch','gulls','gummy','guppy','gusto','gusty','gutsy','gypsy','habit','haiku','handy','happy','harpy','harsh','haste','hasty','haunt','haven','havoc','hazel','heart','heavy','hedge','hefty','heist','hence','herbs','herby','heron','hinge','hippo','hippy','hitch','hived','hoary','hokey','holly','homer','honor','hooky','hotel','house','hover','htile','hulky','human','humor','humph','humus','husky','hyena','hyper','icily','ideal','igloo','image','imbue','impel','imply','inbox','index','indie','inert','infix','inked','inlay','inner','input','inter','inure','irked','irony','islet','itchy','ivory','jaunt','jazzy','jelly','jewel','jiffy','jingo','joist','jolly','joust','jower','jowly','judge','juice','juicy','jumpy','karma','kayak','kinky','kiosk','klutz','knack','knave','knead','kneel','knelt','knife','knobs','knock','knoll','known','kooky','kudos','label','lance','lanky','lardy','large','larva','laser','latch','later','latke','laugh','laxly','layer','leafy','leaky','leapt','learn','lease','least','ledge','leech','leery','lefty','legal','leggy','lemon','lemur','leper','letup','levee','level','liege','lifer','light','limbo','limit','liner','linky','lithe','lived','liver','livid','llama','loath','lodge','logic','loopy','loose','lorry','lousy','lover','lower','lucky','lumpy','lunar','lusty','lymph','lyric','magic','magma','major','maker','mammy','mangy','manic','manly','manor','maple','march','match','matey','mayor','mealy','meaty','media','melee','mercy','merge','merit','merry','messy','metal','mewls','micro','might','minor','minty','minus','mires','mirth','modal','model','mogul','moist','moldy','money','month','moody','moral','mossy','mousy','movie','mower','muddy','muffs','muggy','mulch','multi','mumps','murky','mushy','music','musty','nadir','naive','naked','nanny','nasty','needs','nerve','never','nexus','nifty','night','ninja','nippy','nixed','noble','noise','noisy','north','noted','novel','nower','nubby','nudge','nurse','nutty','nymph','oaken','obese','ocean','offer','often','okapi','oldie','onion','onset','opera','opine','orbed','order','organ','other','otter','ought','outer','overt','ovoid','oxide','ozone','paddy','paged','pager','paint','panic','pansy','papaw','paper','parch','parka','parry','parse','party','pasta','pasty','patch','patio','patsy','pause','pawky','peace','peach','peaky','pearl','pedal','peppy','perky','phase','phone','photo','piano','piece','piety','piggy','pilot','pinch','pique','pivot','pixel','pixie','pizza','place','plain','plane','plank','plant','plash','plate','plaza','plead','pleat','plied','plods','plonk','plops','plots','pluck','plumb','plume','plump','plunk','point','polar','polka','poppy','pouch','pouty','power','prank','prawn','preen','press','price','prick','pride','prime','primp','prior','privy','prize','probe','prose','proud','prove','prowl','prude','psalm','pudgy','puffy','pulpy','pulse','punch','punky','pupil','puppy','purge','pygmy','quack','quaff','quail','quake','qualm','quart','quash','queen','query','quest','queue','quick','quiet','quill','quirk','quite','quota','quote','rabbi','rabid','radar','rainy','raise','rally','ramen','ranch','randy','range','rapid','raspy','ratio','ratty','rayon','reach','react','realm','rebel','rebut','reedy','relax','relay','remix','repay','repel','reply','repro','reset','retro','revel','rider','rifle','right','ripen','risky','rival','river','rivet','robin','robot','rocky','rouge','rough','round','rowdy','rower','royal','ruddy','ruler','rummy','rumor','rural','rusty','saggy','saint','salad','sappy','sauce','saucy','savvy','scale','scant','scare','scarf','scary','scene','scold','scoop','scoot','scope','score','scorn','scour','scout','seedy','seize','sense','serve','seven','shade','shake','shaky','shame','shape','shard','share','sharp','sheen','sheep','sheer','shell','shift','shiny','shirt','shock','shore','short','shout','shove','shown','shrew','sight','silky','silly','since','sinew','sissy','sixth','sixty','skill','skimp','skulk','slant','sleep','sleet','slice','slick','slide','slimy','slope','sloth','slump','slurp','smack','small','smart','smear','smell','smile','smite','smoke','smoky','smote','snafu','snake','snaky','snare','sneak','snide','sniff','snore','snort','snout','snowy','snuck','soggy','solar','solid','solve','soppy','sorry','sound','soupy','south','sower','space','spade','spare','spark','spasm','speak','speck','speed','spend','spice','spiel','spiff','spiky','spill','spine','spire','spite','split','spoke','spoof','spook','spoon','spore','sport','spout','spray','sprig','spunk','squab','squad','squat','squid','staff','stage','staid','stain','stake','stale','stamp','stand','stare','stark','start','stash','state','stave','stays','steal','steam','steel','steep','steer','stern','stink','stoat','stoic','stoke','stomp','stone','stony','store','stork','storm','story','stove','strap','straw','stray','strep','strip','stuck','study','stump','stunt','style','suave','sugar','suite','sulky','sully','sunny','super','surge','surly','swamp','swear','sweep','sweet','swept','swift','swipe','swirl','swoon','swoop','swore','sworn','syrup','table','tacky','taffy','talon','tangy','tapir','tardy','taste','tawny','teach','tears','tease','teeth','tempo','tempt','tense','terms','testy','theft','their','theme','there','these','thick','thing','think','third','thorn','three','threw','throw','thrum','tiger','tight','timer','tipsy','tired','title','toady','toast','today','toddy','token','topaz','topic','torch','torso','total','touch','tough','towel','tower','toxic','trace','track','trade','trail','train','trait','trend','triad','trial','tribe','trick','tried','troop','troth','trout','trove','truce','truck','truly','trump','trunk','trust','truth','tunic','tutor','twice','twist','udder','ulcer','ultra','uncap','uncut','undid','undue','unfit','unify','union','unity','until','unwed','upper','urban','usage','usher','usurp','utter','vague','valid','value','vapid','vault','veiny','verse','verve','vexed','viper','viral','vista','vital','vivid','vocal','vodka','voice','vomit','voter','vouch','vowel','wacky','waist','waken','waltz','warty','waste','watch','water','waxen','weary','weave','wedge','weedy','weigh','weird','wheat','wheel','where','which','whiff','while','whiny','white','whole','whoop','whose','widen','wimpy','windy','witch','witty','woken','woman','women','wonky','wooly','woozy','world','wormy','worry','worse','worst','worth','would','wound','wrath','wrest','wrist','write','wrong','wrung','yacht','yield','young','yours','youth','yucky','yummy','zebra','zesty','zingy','zippy','zonal'];

// ── FRENCH FALLBACK WORD LISTS ──
// 200 common 5-letter French nouns/adjectives/verbs (base forms, no inflections)
const PORT = process.env.PORT || 3000;
const BRAND = 'Brainiacs';
const TAGLINE = '<span data-i18n="home.tagline">Train your brain. One day at a time.</span>';

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3681318443056554" crossorigin="anonymous"><\/script>`;

const CSS = `<style>
:root {
  --black:#141414;--s1:#1c1c1c;--s2:#242424;--s3:#2e2e2e;
  --border:#3a3a3a;--bordm:#4a4a4a;
  --fg:#ffffff;--fg2:#ccc4ba;--fg3:#8a8078;
  --gold:#c9a84c;--goldl:#e4c068;--goldd:#6b5520;--goldg:rgba(201,168,76,.12);
  --green:#4a9e6e;--greenl:#5dbf84;--greend:#1a3d2a;
  --amber:#c49a28;
  --correct:#4a9e6e;--present:#c49a28;--absent:#1e1e1e;--absentt:#4a4a4a;
  --fd:'Playfair Display',Georgia,serif;--fm:'DM Mono',monospace;--fb:'DM Sans',system-ui,sans-serif;
  --r:3px;--rm:5px;--rl:10px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased}
body{background:var(--black);color:var(--fg);font-family:var(--fb);font-size:15px;line-height:1.6;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--gold);text-decoration:none}a:hover{color:var(--goldl)}

.ad-banner{width:100%;background:var(--s1);border-bottom:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding:8px 16px 10px}
.ad-banner--bottom{border-top:1px solid var(--border);border-bottom:none;margin-top:auto}
.ad-label{font-family:var(--fm);font-size:9px;letter-spacing:.14em;color:var(--fg3);text-transform:uppercase;margin-bottom:5px}
.ad-slot{width:100%;max-width:970px}
.ad-placeholder{background:var(--s2);border:1px dashed var(--bordm);border-radius:var(--rm);height:90px;display:flex;align-items:center;justify-content:center;color:var(--fg3);font-family:var(--fm);font-size:11px}

.navbar{background:rgba(20,20,20,.97);backdrop-filter:blur(14px);border-bottom:1px solid var(--border);padding:0 28px;height:58px;display:flex;align-items:center;gap:28px;position:sticky;top:0;z-index:200}
.navbar__logo{display:flex;align-items:center;gap:9px;flex-shrink:0;text-decoration:none!important}
.logo-icon{font-size:18px;filter:drop-shadow(0 0 6px rgba(201,168,76,.5))}
.logo-text{font-family:var(--fd);font-size:21px;font-weight:900;letter-spacing:-.025em;background:linear-gradient(130deg,var(--fg) 40%,var(--gold) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.navbar__links{display:flex;gap:2px;flex:1}
.nav-link{font-family:var(--fm);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg2);padding:7px 14px;border-radius:var(--r);transition:color .15s,background .15s;text-decoration:none!important}
.nav-link:hover{color:var(--fg);background:var(--s2)}
.nav-link.active{color:var(--gold);background:rgba(201,168,76,.07)}
.navbar__right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.navbar__player{background:#f97316;border:none;color:#fff;font-family:var(--fm);font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:7px 16px;border-radius:var(--r);cursor:pointer;transition:background .15s,transform .1s,box-shadow .15s;white-space:nowrap;box-shadow:0 0 12px rgba(249,115,22,.4)}
.navbar__player:hover{background:#ea6c00;transform:translateY(-1px);box-shadow:0 0 20px rgba(249,115,22,.6)}
.friend-btn{background:#ffffff;border:none;color:#141414;font-family:var(--fm);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:7px 14px;border-radius:var(--r);cursor:pointer;display:flex;align-items:center;gap:6px;transition:background .15s,transform .1s;white-space:nowrap}
.friend-btn:hover{background:#e8e8e8;transform:translateY(-1px)}
.friend-btn:active{transform:translateY(0)}
.friend-btn svg{flex-shrink:0}
.invite-modal{position:fixed;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(8px);z-index:600;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
.invite-modal.open{opacity:1;pointer-events:all}
.invite-box{background:var(--s1);border:1px solid var(--bordm);border-radius:16px;padding:32px 28px;width:100%;max-width:420px;margin:16px}
.invite-title{font-family:var(--fp);font-size:22px;font-weight:700;color:var(--fg);margin:0 0 6px}
.invite-sub{font-size:13px;color:var(--fg2);margin:0 0 24px;line-height:1.5}
.invite-link-row{display:flex;gap:8px;margin-bottom:20px}
.invite-link-input{flex:1;background:var(--s3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:var(--fm);font-size:12px;color:var(--fg);outline:none;min-width:0}
.invite-copy-btn{background:var(--fg);color:var(--black);border:none;border-radius:8px;padding:10px 16px;font-family:var(--fm);font-size:11px;font-weight:700;letter-spacing:.06em;cursor:pointer;white-space:nowrap;transition:background .15s}
.invite-copy-btn:hover{background:#ddd}
.invite-copy-btn.copied{background:#4caf50;color:#fff}
.invite-share-title{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg3);margin-bottom:12px}
.invite-share-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px}
.share-btn{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--s2);cursor:pointer;transition:border-color .15s,background .15s;text-decoration:none}
.share-btn:hover{border-color:var(--bordm);background:var(--s3)}
.share-btn__icon{font-size:22px;line-height:1;flex-shrink:0}
.share-btn__text{display:flex;flex-direction:column;gap:1px}
.share-btn__label{font-family:var(--fm);font-size:12px;font-weight:600;color:var(--fg);letter-spacing:.02em}
.share-btn__desc{font-size:10px;color:var(--fg3)}
.invite-close{width:100%;background:transparent;border:1px solid var(--border);color:var(--fg2);border-radius:8px;padding:10px;font-family:var(--fm);font-size:12px;cursor:pointer;transition:border-color .15s}
.invite-close:hover{border-color:var(--bordm);color:var(--fg)}
.navbar__help{width:34px;height:34px;border-radius:50%;background:transparent;border:1.5px solid var(--bordm);color:var(--fg2);font-family:var(--fm);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .15s,color .15s,background .15s,box-shadow .15s;flex-shrink:0}
.navbar__center{flex:1;display:flex;justify-content:center;align-items:center}
.lang-btn{background:#f5d800;border:none;color:#1a1400;font-family:var(--fm);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:7px 16px;border-radius:var(--r);cursor:pointer;transition:background .15s,transform .1s,box-shadow .15s;white-space:nowrap;display:flex;align-items:center;gap:7px;box-shadow:0 0 12px rgba(245,216,0,.3)}
.lang-btn:hover{background:#fce500;transform:translateY(-1px);box-shadow:0 0 20px rgba(245,216,0,.5)}
.lang-btn:active{transform:translateY(0)}
.lang-flag{font-size:16px;line-height:1}
.lang-label{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--fg2)}
.lang-sep{color:var(--fg3);font-size:10px}
.navbar__help:hover{border-color:var(--gold);color:var(--gold);background:var(--goldg);box-shadow:0 0 14px rgba(201,168,76,.25)}

.footer{background:var(--s1);border-top:1px solid var(--border);text-align:center;padding:18px;font-family:var(--fm);font-size:11px;color:var(--fg3);letter-spacing:.04em}
.footer a{color:#4a4035}

.btn-primary{background:linear-gradient(135deg,var(--gold),var(--goldl));color:#0a0a0a;font-family:var(--fm);font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;padding:12px 28px;border:none;border-radius:var(--r);cursor:pointer;transition:opacity .15s,transform .1s,box-shadow .15s;box-shadow:0 2px 18px rgba(201,168,76,.28)}
.btn-primary:hover{opacity:.9;box-shadow:0 4px 28px rgba(201,168,76,.42)}.btn-primary:active{transform:scale(.97)}
.btn-secondary{background:transparent;border:1px solid var(--bordm);color:var(--fg2);font-family:var(--fm);font-size:12px;letter-spacing:.09em;text-transform:uppercase;padding:12px 24px;border-radius:var(--r);cursor:pointer;transition:border-color .15s,color .15s,background .15s;display:inline-block;text-align:center}
.btn-secondary:hover{border-color:var(--gold);color:var(--gold);background:var(--goldg)}

.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:500;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
.modal-overlay.open{opacity:1;pointer-events:all}
.modal{background:var(--s2);border:1px solid var(--bordm);border-radius:var(--rl);padding:32px 32px 28px;max-width:420px;width:90%;position:relative;animation:mIn .3s cubic-bezier(.34,1.56,.64,1)}
@keyframes mIn{from{transform:scale(.92) translateY(10px)}to{transform:scale(1) translateY(0)}}
.modal h2{font-family:var(--fd);font-size:26px;font-weight:700;margin-bottom:10px}
.modal>p{color:var(--fg2);margin-bottom:20px;font-size:14px}
.modal input[type=text]{width:100%;background:var(--s3);border:1px solid var(--bordm);color:var(--fg);font-family:var(--fm);font-size:14px;padding:12px 16px;border-radius:var(--rm);margin-bottom:16px;outline:none;transition:border-color .15s,box-shadow .15s}
.modal input:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.1)}
.modal__close{position:absolute;top:16px;right:20px;font-size:20px;color:var(--fg2);cursor:pointer;transition:color .12s;line-height:1}
.modal__close:hover{color:var(--fg)}

.toast{position:fixed;top:76px;left:50%;transform:translateX(-50%) translateY(-10px);background:var(--fg);color:var(--black);font-family:var(--fm);font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;padding:10px 22px;border-radius:var(--r);opacity:0;pointer-events:none;z-index:999;transition:opacity .18s,transform .18s;box-shadow:0 4px 24px rgba(0,0,0,.6)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.section-title{font-family:var(--fm);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin-bottom:22px}
@media(max-width:600px){.navbar{padding:0 16px;gap:10px}.nav-link{padding:6px 8px;font-size:10px}.navbar__player:active{transform:translateY(0)}}

/* ── MOBILE HAMBURGER NAV ─────────────────────────────────── */
.nav-menu-btn{display:none;background:transparent;border:none;cursor:pointer;padding:6px 4px;flex-direction:column;gap:5px;align-items:center;justify-content:center;flex-shrink:0}
.nav-menu-btn span{display:block;width:20px;height:2px;background:var(--fg2);border-radius:1px;transition:background .15s}
.nav-menu-btn:hover span{background:var(--fg)}
.nav-drawer{position:fixed;inset:0;z-index:400;display:none}
.nav-drawer.open{display:block}
.nav-drawer__bd{position:absolute;inset:0;background:rgba(0,0,0,.72)}
.nav-drawer__panel{position:absolute;top:0;right:0;bottom:0;width:240px;background:var(--s1);border-left:1px solid var(--border);display:flex;flex-direction:column;padding:16px 12px;gap:4px;overflow-y:auto}
.nav-drawer__close{align-self:flex-end;background:transparent;border:none;color:var(--fg3);font-size:22px;cursor:pointer;padding:4px 8px;line-height:1;margin-bottom:4px}
.nav-drawer__close:hover{color:var(--fg)}
.nav-dlink{font-family:var(--fm);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg2);padding:11px 14px;border-radius:var(--r);display:block;text-decoration:none!important;transition:color .15s,background .15s;background:transparent;border:none;cursor:pointer;text-align:left;width:100%}
.nav-dlink:hover,.nav-dlink:focus{color:var(--fg);background:var(--s2)}
.nav-dlink.active{color:var(--gold)}
.nav-dlink.clr-orange{color:#f97316;font-weight:700}
.nav-dlink.clr-yellow{color:#f5d800;font-weight:700}
.nav-dlink.clr-white{color:#fff;font-weight:700}
.nav-drawer__sep{height:1px;background:var(--border);margin:6px 0}
@media(max-width:640px){
  .nav-menu-btn{display:flex}
  .navbar__links{display:none}
  .navbar__right{display:none}
  .ad-banner{display:none}
}

/* ── GAME PAGE VIEWPORT FIT ─────────────────────────────────── */
body.game-page{height:100dvh;overflow:hidden;display:flex;flex-direction:column}
body.game-page .game-main{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}
body.game-page .footer{display:none}
body.game-page .ad-banner--bottom{display:none}
@media(max-width:640px){
  body.game-page .gh{padding:10px 16px 8px}
  body.game-page .gt{font-size:22px}
  body.game-page .gs{font-size:10px;margin-top:2px}
  body.game-page .gm{font-size:10px;margin-top:2px}
  body.game-page .game-main{padding:12px 16px 16px}
}
@media(max-height:820px){
  body.game-page .gh{padding:10px 16px 8px}
  body.game-page .gt{font-size:26px}
  body.game-page .gs{font-size:10px;margin-top:2px}
  body.game-page .game-main{padding:14px 16px 18px;gap:14px}
}
@media(max-height:680px){
  body.game-page .gh{padding:6px 16px 6px}
  body.game-page .gt{font-size:22px}
  body.game-page .gs{display:none}
  body.game-page .gm{display:none}
  body.game-page .game-main{padding:8px 16px 10px;gap:8px}
}
</style>`;


const I18N = `<script>
(function(){
  var LANG = localStorage.getItem('bn_lang') || 'en';
  var T = {
    en: {
      // Nav
      'nav.games': 'Games', 'nav.rankings': 'Rankings', 'nav.badges': 'Badges',
      'nav.language': 'Language', 'nav.setname': 'Set Name', 'nav.addfriend': 'Add a Friend',
      // Home
      'home.tagline': 'Train your brain. One day at a time.',
      'home.choose': 'Choose your skill to train',
      'home.globalrankings': 'Global Rankings',
      'home.live': 'Live',
      'home.profile.games': 'Games Played',
      'home.profile.winrate': 'Win Rate',
      'home.profile.strength': 'Strengths',
      'home.profile.weakness': 'Weaknesses',
      // Game descriptions
      'game.wordle.desc': 'Vocabulary',
      'game.wordle.sub': 'Logic &amp; vocabulary.',
      'game.pathle.desc': 'Logic',
      'game.pathle.sub': 'One letter at a time.',
      'game.fastspell.desc': 'Word Power',
      'game.fastspell.sub': 'Race the clock.',
      'game.blindle.desc': 'Blind Guess',
      'game.blindle.sub': 'Deduction without hints.',
      // Wordle
      'wordle.title': 'Wordle', 'wordle.subtitle': 'Guess the 5-letter word in 6 tries',
      'wordle.howtoplay': 'How to Play',
      'wordle.rule1': '<span data-i18n="wordle.rule1">Each guess must be a valid 5-letter word.</span>',
      'wordle.rule2': '<span data-i18n="wordle.rule2">Tile colours show how close you are.</span>',
      'wordle.notenough': 'Not enough letters', 'wordle.notinlist': 'Not in word list',
      'wordle.played': 'Played', 'wordle.winrate': 'Win Rate', 'wordle.streak': 'Streak',
      'wordle.maxstreak': 'Max Streak', 'wordle.avgguesses': 'Avg Guesses',
      'wordle.distribution': 'Guess Distribution',
      'wordle.share': 'Share 📋', 'wordle.rankings': 'Rankings',
      'wordle.genius': 'Genius!', 'wordle.magnificent': 'Magnificent!',
      'wordle.impressive': 'Impressive!', 'wordle.splendid': 'Splendid!',
      'wordle.great': 'Great!', 'wordle.phew': 'Phew!',
      'wordle.nextwordle': 'Next Wordle',
      // Pathle
      'pathle.title': 'Pathle', 'pathle.subtitle': 'Transform the word — one letter at a time',
      'pathle.rule': 'Change exactly one letter per step to reach the target.',
      'pathle.from': 'FROM', 'pathle.to': 'TO', 'pathle.par': 'Par',
      'pathle.submit': 'Submit', 'pathle.undo': '↩ Undo', 'pathle.giveup': 'Give Up',
      'pathle.onechange': 'Change exactly one letter',
      'pathle.completeword': 'Complete the word first',
      'pathle.notvalid': 'Not a valid word',
      'pathle.sameword': 'Same word as before',
      'pathle.noundo': 'Nothing to undo',
      'pathle.solvedin': 'Solved in', 'pathle.steps': 'steps',
      'pathle.played': 'Played', 'pathle.won': 'Won', 'pathle.best': 'Best', 'pathle.streak': 'Streak',
      'pathle.playagain': 'Play Again', 'pathle.rankings': 'Rankings',
      // FastSpell
      'fs.title': 'FastSpell', 'fs.subtitle': 'Race the clock — spell as many words as you can',
      'fs.start': '▶ START', 'fs.center': 'must use center letter',
      'fs.timesup': "Time's Up! ⏱", 'fs.already': 'Already found!',
      'fs.tooshort': 'Too short!', 'fs.notinlist': 'Not in word list',
      'fs.played': 'Played', 'fs.bestscore': 'Best Score', 'fs.wordsfound': 'Words Found',
      'fs.share': 'Share Result', 'fs.next': 'Next FastSpell',
      // Blindle
      'blindle.title': 'Blindle', 'blindle.subtitle': 'Guess the word — no colour hints',
      'blindle.notenough': 'Not enough letters', 'blindle.notinlist': 'Not in word list',
      'blindle.played': 'Played', 'blindle.winrate': 'Win Rate', 'blindle.streak': 'Streak',
      'blindle.maxstreak': 'Max Streak', 'blindle.avgguesses': 'Avg Guesses',
      'blindle.share': 'Share 📋', 'blindle.rankings': 'Rankings',
      'blindle.nextblinde': 'Next Blindle',
      // Rankings
      'rankings.title': 'Rankings',
      'rankings.player': 'Player', 'rankings.played': 'Played',
      'rankings.wins': 'Wins', 'rankings.winrate': 'Win %',
      'rankings.streak': 'Streak', 'rankings.avg': 'Avg',
      'rankings.noplayers': 'No players yet — play a game first!',
      // Badges
      'badges.title': 'Your Badges',
      'badges.subtitle': 'Complete long-term challenges to earn badges across all games.',
      'badges.earned': 'Earned', 'badges.total': 'Total', 'badges.complete': 'Complete',
      'badges.earnedtag': '✓ Earned',
      // Badge names & descs
      'badge.first_step': 'First Step', 'badge.first_step.desc': 'Play your first game of any kind',
      'badge.regular': 'Regular', 'badge.regular.desc': 'Play 7 games total',
      'badge.devoted': 'Devoted', 'badge.devoted.desc': 'Play 30 games total',
      'badge.centurion': 'Centurion', 'badge.centurion.desc': 'Play 100 games total',
      'badge.wordle_fan': 'Wordle Fan', 'badge.wordle_fan.desc': 'Play 20 Wordle games',
      'badge.pathle_fan': 'Pathfinder', 'badge.pathle_fan.desc': 'Play 20 Pathle games',
      'badge.spell_fan': 'Spellbound', 'badge.spell_fan.desc': 'Play 20 FastSpell games',
      'badge.blind_fan': 'Blindfolded', 'badge.blind_fan.desc': 'Play 20 Blindle games',
      'badge.first_win': 'First Win', 'badge.first_win.desc': 'Win your first game',
      'badge.hat_trick': 'Hat Trick', 'badge.hat_trick.desc': 'Reach a win streak of 3',
      'badge.on_fire': 'On Fire', 'badge.on_fire.desc': 'Reach a win streak of 7',
      'badge.wordle_ace': 'Wordle Ace', 'badge.wordle_ace.desc': 'Win 10 Wordle games',
      'badge.sharp_mind': 'Sharp Mind', 'badge.sharp_mind.desc': 'Solve Wordle in 2 guesses',
      'badge.blind_win': 'Blind Win', 'badge.blind_win.desc': 'Win a Blindle game',
      'badge.blind_ace': 'Blind Ace', 'badge.blind_ace.desc': 'Win 10 Blindle games',
      'badge.spell_start': 'Getting Started', 'badge.spell_start.desc': 'Score 10pts in FastSpell',
      'badge.spell_cast': 'Spell Caster', 'badge.spell_cast.desc': 'Score 50pts in FastSpell',
      'badge.wizard': 'Wizard', 'badge.wizard.desc': 'Score 100pts in FastSpell',
      'badge.pangram': 'Pangram Hunter', 'badge.pangram.desc': 'Find a pangram in FastSpell',
      'badge.all_four': 'All In', 'badge.all_four.desc': 'Play all 4 game modes',
      'badge.completionist': 'Completionist', 'badge.completionist.desc': 'Win in all 4 modes',
      'badge.veteran': 'Veteran', 'badge.veteran.desc': 'Play 50 total games',
      'badge.legend': 'Legend', 'badge.legend.desc': 'Play 200 total games',
      // Badge categories
      'badgecat.First Steps': 'First Steps', 'badgecat.Victories': 'Victories',
      'badgecat.FastSpell': 'FastSpell', 'badgecat.Dedication': 'Dedication',
      // Friend modal
      'friend.title': 'Invite a Friend', 'friend.subtitle': '<span data-i18n="friend.subtitle">Share Brainiacs with someone — challenge them on the same daily words!</span>',
      'friend.copy': 'Copy', 'friend.copied': '✓ Copied!', 'friend.sharedirectly': 'Share directly',
      'friend.close': 'Close', 'friend.wa': 'WhatsApp', 'friend.wa.desc': 'Send a message',
      'friend.email': 'Email', 'friend.email.desc': 'Send an invite',
      'friend.tg': 'Telegram', 'friend.tg.desc': 'Share in chat',
      'friend.sms': 'SMS / iMessage', 'friend.sms.desc': 'Text a friend',
      'friend.twitter': 'X / Twitter', 'friend.twitter.desc': 'Post to your followers',
      // Share text
      'share.msg': 'Play Brainiacs with me — daily word puzzles! ',
      'share.emailsubject': 'Play Brainiacs with me!',
      // Common
      'common.close': 'Close', 'common.copied': 'Copied!', 'common.cannotcopy': 'Could not copy',
      'home.wordle.desc': 'Crack the 5-letter word in 6 tries.<br>Vocabulary &amp; deduction.',
      'home.pathle.desc': 'Transform one word into another, one letter at a time.<br>Logic &amp; vocabulary.',
      'home.fs.desc': 'Build words from 7 letters. The centre letter is mandatory.',
      'home.blindle.desc': 'Guess the word in 9 tries — but you only see counts.<br>Deduction without hints.',
    },

    fr: {
      // Nav
      'nav.games': 'Jeux', 'nav.rankings': 'Classement', 'nav.badges': 'Badges',
      'nav.language': 'Langue', 'nav.setname': 'Mon Nom', 'nav.addfriend': 'Inviter un Ami',
      // Home
      'home.tagline': 'Entraîne ton cerveau. Un jour à la fois.',
      'home.choose': 'Choisissez votre compétence',
      'home.globalrankings': 'Classement Mondial',
      'home.live': 'En direct',
      'home.profile.games': 'Parties Jouées',
      'home.profile.winrate': 'Taux de Victoire',
      'home.profile.strength': 'Points Forts',
      'home.profile.weakness': 'Points Faibles',
      // Game descriptions
      'game.wordle.desc': 'Vocabulaire',
      'game.wordle.sub': 'Logique &amp; vocabulaire.',
      'game.pathle.desc': 'Logique',
      'game.pathle.sub': 'Une lettre à la fois.',
      'game.fastspell.desc': 'Puissance des mots',
      'game.fastspell.sub': 'Contre la montre.',
      'game.blindle.desc': 'Devinette aveugle',
      'game.blindle.sub': 'Déduction sans indices.',
      // Wordle
      'wordle.title': 'Wordle', 'wordle.subtitle': 'Devinez le mot de 5 lettres en 6 essais',
      'wordle.howtoplay': 'Comment jouer',
      'wordle.rule1': 'Chaque essai doit être un mot valide de 5 lettres.',
      'wordle.rule2': 'Les couleurs des cases indiquent votre proximité.',
      'wordle.notenough': 'Pas assez de lettres', 'wordle.notinlist': 'Mot inconnu',
      'wordle.played': 'Joué', 'wordle.winrate': 'Victoires', 'wordle.streak': 'Série',
      'wordle.maxstreak': 'Série max', 'wordle.avgguesses': 'Moy. essais',
      'wordle.distribution': 'Distribution des essais',
      'wordle.share': 'Partager 📋', 'wordle.rankings': 'Classement',
      'wordle.genius': 'Génie !', 'wordle.magnificent': 'Magnifique !',
      'wordle.impressive': 'Impressionnant !', 'wordle.splendid': 'Splendide !',
      'wordle.great': 'Bravo !', 'wordle.phew': 'Ouf !',
      'wordle.nextwordle': 'Prochain Wordle',
      // Pathle
      'pathle.title': 'Pathle', 'pathle.subtitle': 'Transformez le mot — une lettre à la fois',
      'pathle.rule': 'Changez exactement une lettre par étape pour atteindre la cible.',
      'pathle.from': 'DÉPART', 'pathle.to': 'ARRIVÉE', 'pathle.par': 'Référence',
      'pathle.submit': 'Valider', 'pathle.undo': '↩ Annuler', 'pathle.giveup': 'Abandonner',
      'pathle.onechange': 'Changez exactement une lettre',
      'pathle.completeword': 'Complétez le mot d’abord',
      'pathle.notvalid': 'Mot invalide',
      'pathle.sameword': 'Même mot qu’avant',
      'pathle.noundo': 'Rien à annuler',
      'pathle.solvedin': 'Résolu en', 'pathle.steps': 'étapes',
      'pathle.played': 'Joué', 'pathle.won': 'Gagné', 'pathle.best': 'Meilleur', 'pathle.streak': 'Série',
      'pathle.playagain': 'Rejouer', 'pathle.rankings': 'Classement',
      // FastSpell
      'fs.title': 'FastSpell', 'fs.subtitle': 'Contre la montre — épelle un maximum de mots',
      'fs.start': '▶ DÉMARRER', 'fs.center': 'lettre centrale obligatoire',
      'fs.timesup': 'Temps écoulé ! ⏱', 'fs.already': 'Déjà trouvé !',
      'fs.tooshort': 'Trop court !', 'fs.notinlist': 'Mot inconnu',
      'fs.played': 'Joué', 'fs.bestscore': 'Meilleur score', 'fs.wordsfound': 'Mots trouvés',
      'fs.share': 'Partager', 'fs.next': 'Prochain FastSpell',
      // Blindle
      'blindle.title': 'Blindle', 'blindle.subtitle': 'Devinez le mot — sans indices de couleur',
      'blindle.notenough': 'Pas assez de lettres', 'blindle.notinlist': 'Mot inconnu',
      'blindle.played': 'Joué', 'blindle.winrate': 'Victoires', 'blindle.streak': 'Série',
      'blindle.maxstreak': 'Série max', 'blindle.avgguesses': 'Moy. essais',
      'blindle.share': 'Partager 📋', 'blindle.rankings': 'Classement',
      'blindle.nextblinde': 'Prochain Blindle',
      // Rankings
      'rankings.title': 'Classement',
      'rankings.player': 'Joueur', 'rankings.played': 'Joué',
      'rankings.wins': 'Victoires', 'rankings.winrate': 'Vic. %',
      'rankings.streak': 'Série', 'rankings.avg': 'Moy.',
      'rankings.noplayers': 'Aucun joueur — jouez d’abord une partie !',
      // Badges
      'badges.title': 'Vos Badges',
      'badges.subtitle': 'Relevez des défis à long terme pour gagner des badges.',
      'badges.earned': 'Obtenus', 'badges.total': 'Total', 'badges.complete': 'Complété',
      'badges.earnedtag': '✓ Obtenu',
      // Badge names & descs
      'badge.first_step': 'Premier Pas', 'badge.first_step.desc': 'Jouez votre première partie',
      'badge.regular': 'Régulier', 'badge.regular.desc': '7 parties au total',
      'badge.devoted': 'Dévoué', 'badge.devoted.desc': '30 parties au total',
      'badge.centurion': 'Centurion', 'badge.centurion.desc': '100 parties au total',
      'badge.wordle_fan': 'Fan de Wordle', 'badge.wordle_fan.desc': '20 parties de Wordle',
      'badge.pathle_fan': 'Explorateur', 'badge.pathle_fan.desc': '20 parties de Pathle',
      'badge.spell_fan': 'Épelleur', 'badge.spell_fan.desc': '20 parties de FastSpell',
      'badge.blind_fan': 'Aveugle', 'badge.blind_fan.desc': '20 parties de Blindle',
      'badge.first_win': 'Première Victoire', 'badge.first_win.desc': 'Gagnez votre première partie',
      'badge.hat_trick': 'Hat Trick', 'badge.hat_trick.desc': 'Série de 3 victoires',
      'badge.on_fire': 'En Feu', 'badge.on_fire.desc': 'Série de 7 victoires',
      'badge.wordle_ace': 'As du Wordle', 'badge.wordle_ace.desc': '10 victoires au Wordle',
      'badge.sharp_mind': 'Esprit Vif', 'badge.sharp_mind.desc': 'Wordle en 2 essais max',
      'badge.blind_win': 'Victoire Aveugle', 'badge.blind_win.desc': 'Gagnez un Blindle',
      'badge.blind_ace': 'As Aveugle', 'badge.blind_ace.desc': '10 victoires au Blindle',
      'badge.spell_start': 'Premiers Mots', 'badge.spell_start.desc': '10 pts en FastSpell',
      'badge.spell_cast': 'Jeteur de Sorts', 'badge.spell_cast.desc': '50 pts en FastSpell',
      'badge.wizard': 'Sorcier', 'badge.wizard.desc': '100 pts en FastSpell',
      'badge.pangram': 'Chasseur de Pangramme', 'badge.pangram.desc': 'Trouvez un pangramme',
      'badge.all_four': 'Tout ou Rien', 'badge.all_four.desc': 'Jouez les 4 modes',
      'badge.completionist': 'Perfectionniste', 'badge.completionist.desc': 'Gagnez dans les 4 modes',
      'badge.veteran': 'Vétéran', 'badge.veteran.desc': '50 parties au total',
      'badge.legend': 'Légende', 'badge.legend.desc': '200 parties au total',
      // Badge categories
      'badgecat.First Steps': 'Premiers Pas', 'badgecat.Victories': 'Victoires',
      'badgecat.FastSpell': 'FastSpell', 'badgecat.Dedication': 'Dévouement',
      // Friend modal
      'friend.title': 'Inviter un Ami', 'friend.subtitle': 'Partagez Brainiacs — défiez-vous sur les mêmes mots !',
      'friend.copy': 'Copier', 'friend.copied': '✓ Copié !', 'friend.sharedirectly': 'Partager directement',
      'friend.close': 'Fermer', 'friend.wa': 'WhatsApp', 'friend.wa.desc': 'Envoyer un message',
      'friend.email': 'E-mail', 'friend.email.desc': 'Envoyer une invitation',
      'friend.tg': 'Telegram', 'friend.tg.desc': 'Partager dans un chat',
      'friend.sms': 'SMS / iMessage', 'friend.sms.desc': 'Envoyer par SMS',
      'friend.twitter': 'X / Twitter', 'friend.twitter.desc': 'Publier sur votre fil',
      // Share text
      'share.msg': 'Joue à Brainiacs avec moi — des mots à deviner chaque jour ! ',
      'share.emailsubject': 'Joue à Brainiacs avec moi !',
      // Common
      'common.close': 'Fermer', 'common.copied': 'Copié !', 'common.cannotcopy': 'Impossible de copier',
      'home.wordle.desc': 'Devinez le mot en 6 essais.<br>Vocabulaire &amp; déduction.',
      'home.pathle.desc': 'Transformez un mot en un autre, une lettre à la fois.',
      'home.fs.desc': 'Formez des mots avec 7 lettres. La lettre centrale est obligatoire.',
      'home.blindle.desc': 'Devinez le mot en 9 essais — seulement les comptes.',
    }


  };
  // Expose globally
  window._T = T[LANG] || T['en'];
  window._LANG = LANG;
  // Apply translations to all [data-i18n] elements after DOM is ready
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      var val = window._T[key];
      if (val !== undefined) el.innerHTML = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-placeholder');
      var val = window._T[key];
      if (val !== undefined) el.placeholder = val;
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyI18n);
  } else {
    applyI18n();
  }
})();
</script>
`;

const SHARED_JS = `<script>
var DEV_MODE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const Player = (function() {
  const K = 'bn_player';
  function _get() { try { var r = localStorage.getItem(K); return r ? JSON.parse(r) : null; } catch(e) { return null; } }
  function _set(d) { localStorage.setItem(K, JSON.stringify(d)); }
  return {
    getName: function() { var p = _get(); return p ? p.name : null; },
    getOrCreate: function() { var p = _get(); if (!p) { p = { id: Math.random().toString(36).slice(2), name: null }; _set(p); } return p; },
    setName: function(n) { var p = this.getOrCreate(); p.name = n.trim(); _set(p); if(window.BnSync) BnSync.patchName(p.name); }
  };
})();
const GameStats = (function() {
  var SP = 'bn_stats_', RP = 'bn_rank_';
  function _def() { return { played:0, wins:0, currentStreak:0, maxStreak:0, totalGuessesOnWin:0, distribution:{1:0,2:0,3:0,4:0,5:0,6:0} }; }
  function getStats(g) { if(DEV_MODE) return _def(); try { var r = localStorage.getItem(SP+g); return r ? Object.assign(_def(), JSON.parse(r)) : _def(); } catch(e) { return _def(); } }
  function saveStats(g, s) { if(DEV_MODE) return; localStorage.setItem(SP+g, JSON.stringify(s)); }
  function _syncRank(g, s) {
    if(DEV_MODE) return;
    var p = Player.getOrCreate(); if (!p.name) return;
    var rows = getRankings(g), i = rows.findIndex(function(x){return x.playerId===p.id;});
    var e = { playerId:p.id, name:p.name, played:s.played, wins:s.wins, totalGuessesOnWin:s.totalGuessesOnWin, maxStreak:s.maxStreak };
    if (i >= 0) rows[i] = e; else rows.push(e);
    localStorage.setItem(RP+g, JSON.stringify(rows));
  }
  function getRankings(g) { try { var r = localStorage.getItem(RP+g); return r ? JSON.parse(r) : []; } catch(e) { return []; } }
  return {
    getStats: getStats,
    recordResult: function(g, won, guesses) {
      var s = getStats(g); s.played++;
      if (won) { s.wins++; s.currentStreak++; s.maxStreak = Math.max(s.maxStreak, s.currentStreak); s.totalGuessesOnWin += guesses; var k = String(Math.min(guesses,6)); s.distribution[k] = (s.distribution[k]||0)+1; }
      else { s.currentStreak = 0; }
      saveStats(g, s); _syncRank(g, s); if(window.BnSync) BnSync.postState(g, s); return s;
    },
    getWinRate: function(s) { return (!s||s.played===0) ? 0 : Math.round(s.wins/s.played*100); },
    getAvgGuesses: function(s) { return (!s||s.wins===0) ? null : (s.totalGuessesOnWin/s.wins).toFixed(2); },
    getSortedRankings: function(g) {
      return getRankings(g).sort(function(a,b){
        var wa=a.played>0?a.wins/a.played:0, wb=b.played>0?b.wins/b.played:0;
        if (wb!==wa) return wb-wa;
        var ga=a.wins>0?a.totalGuessesOnWin/a.wins:99, gb=b.wins>0?b.totalGuessesOnWin/b.wins:99;
        if (ga!==gb) return ga-gb;
        return b.played-a.played;
      });
    },
    refreshPlayerName: function(g) {
      var p = Player.getOrCreate(); if (!p.name) return;
      var rows = getRankings(g), i = rows.findIndex(function(x){return x.playerId===p.id;});
      if (i>=0) { rows[i].name=p.name; localStorage.setItem(RP+g, JSON.stringify(rows)); }
    }
  };
})();
// ── SERVER SYNC ─────────────────────────────────────────────────────────────
// Fire-and-forget sync to PostgreSQL via API routes.
// Falls back silently if server has no DATABASE_URL configured.
var BnSync = (function() {
  function getBnUID() {
    var m = document.cookie.match(/(?:^|;\\s*)bn_uid=([^;]+)/);
    return m ? m[1] : null;
  }
  return {
    uid: getBnUID,
    postState: function(game, stats) {
      try {
        fetch('/api/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            game: game,
            played: stats.played,
            wins: stats.wins,
            currentStreak: stats.currentStreak,
            maxStreak: stats.maxStreak,
            totalGuessesOnWin: stats.totalGuessesOnWin,
            distribution: stats.distribution
          })
        }).catch(function() {});
      } catch(e) {}
    },
    patchName: function(name) {
      try {
        fetch('/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        }).catch(function() {});
      } catch(e) {}
    },
    fetchRankings: function(game, cb) {
      fetch('/api/rankings?game=' + encodeURIComponent(game))
        .then(function(r) { if (!r.ok) throw new Error('no db'); return r.json(); })
        .then(cb)
        .catch(function() { cb(GameStats.getSortedRankings(game)); });
    }
  };
})();

document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('playerBtn');
  var nameSpan = document.getElementById('playerName');
  var modal = document.getElementById('playerModal');
  var input = document.getElementById('playerNameInput');
  var save = document.getElementById('savePlayerName');
  function refresh() { if (nameSpan) nameSpan.textContent = Player.getName() || 'Set Name'; }
  if (btn) btn.addEventListener('click', function() { if (input) input.value = Player.getName()||''; modal.classList.add('open'); setTimeout(function(){if(input)input.focus();},50); });
  if (save) save.addEventListener('click', function() { var v=input.value.trim(); if(!v)return; Player.setName(v); modal.classList.remove('open'); refresh(); });
  if (input) input.addEventListener('keydown', function(e){ if(e.key==='Enter')save&&save.click(); });
  if (modal) modal.addEventListener('click', function(e){ if(e.target===modal)modal.classList.remove('open'); });
  Player.getOrCreate(); refresh();
  if(DEV_MODE) {
    var b = document.createElement('div');
    b.style.cssText='position:fixed;bottom:12px;right:12px;background:#e05c5c;color:#fff;font-family:monospace;font-size:10px;padding:4px 8px;border-radius:4px;z-index:9999;opacity:.8;pointer-events:none';
    b.textContent='DEV — no cache';
    document.body.appendChild(b);
  }

  // i18n: translate UI for French
  (function(){
    var l=localStorage.getItem('bn_lang')||'en';
    if(l!=='fr') return;
    var map={
      'Set Name':'Pseudo','Add a Friend':'Inviter un ami','Language':'Langue',
      'Games':'Jeux','Rankings':'Classement',
      'Choose your skill to train':'Choisissez votre comp\u00e9tence',
      'Pick a game':'Choisir un jeu','Vocabulary':'Vocabulaire',
      'Logic':'Logique','Word Power':'Force du mot','Blind Guess':'Devinette aveugle',
      'Not in word list':'Mot inconnu','Not enough letters':'Pas assez de lettres',
      'Already guessed!':'D\u00e9j\u00e0 essay\u00e9 !',
      'Give Up':'Abandonner','Undo':'Annuler',
      'Played':'Jou\u00e9s','Win Rate':'Victoires','Current Streak':'S\u00e9rie en cours',
      'Best Streak':'Meilleure s\u00e9rie','Guess Distribution':'R\u00e9partition des essais',
      'Play Again Tomorrow':'Rejouer demain','Share':'Partager',
      'Next word in':'Prochain mot dans',
      'START':'D\u00c9MARRER','Time up!':'Temps \u00e9coul\u00e9 !','Pangram!':'Pangramme !',
      'Best Score':'Meilleur score','Words Found':'Mots trouv\u00e9s',
      'Earned':'Obtenu','Your Badges':'Vos badges',
      'First Steps':'Premiers pas','Victories':'Victoires','Dedication':'D\u00e9votion',
    };
    document.addEventListener('DOMContentLoaded',function(){
      document.querySelectorAll('button,a,span,h1,h2,h3,p,label').forEach(function(el){
        if(!el.children.length){var t=el.textContent.trim();if(map[t])el.textContent=map[t];}
      });
    });
  })();
});
</script>`;

const AD_TOP = `<div class="ad-banner"><div class="ad-label">Advertisement</div><div class="ad-slot"><div class="ad-placeholder"><span>728 × 90 — Leaderboard Ad</span></div></div></div>`;
const AD_BOT = `<div class="ad-banner ad-banner--bottom"><div class="ad-label">Advertisement</div><div class="ad-slot"><div class="ad-placeholder"><span>728 × 90 — Leaderboard Ad</span></div></div></div>`;
const FOOTER = `<footer class="footer"><p>© 2026 ${BRAND} · <a href="#">Privacy</a> · <a href="#">Terms</a></p></footer>`;
// ── FRENCH FALLBACK WORD LISTS ──
// Pre-filtered fallback lists (computed once at startup)
const FALLBACK_PW_FILTERED = filterAnswerWords(FALLBACK_PW);
// Wordle/Blindle share the same fallback pool as Pathle
const FALLBACK_ANSWERS_FILTERED = FALLBACK_PW_FILTERED;
const FALLBACK_EXTRAS = FALLBACK_PW; // full list for guess validation

const FR_ANSWERS_5 = ['abime','achat','acier','ambre','amour','ancre','anime','arbre','arche','arene','armes','arret','astre','atlas','atout','autre','avare','avide','avoir','bague','banal','bande','barbe','barre','baume','belle','berce','beton','biere','bilan','bison','bombe','brave','brume','bulle','cache','cadre','calme','canne','cargo','carpe','carre','carte','caste','cause','ceder','chair','chene','chose','cible','clair','clone','coche','coeur','colon','corps','coude','crane','creme','crepe','creux','crise','cuire','culot','cumul','cycle','dalle','danse','debut','degre','delta','dense','depot','dette','droit','duvet','eclat','ecran','elite','email','encre','envie','epave','epine','equip','erode','essor','etage','etale','etang','etape','etude','evade','exile','fable','faute','femme','fente','ferme','fiche','filou','fleur','flute','folie','force','forge','forme','franc','front','fugue','fusee','gaine','gamme','garde','genre','globe','grace','grade','grave','greve','guile','havre','herbe','heron','heure','homme','hotel','houle','image','isole','jaune','jeune','jouet','joute','label','laine','lampe','lance','large','latex','laver','leger','libre','linge','litre','livre','local','loque','loupe','loyal','lueur','magic','manie','marre','match','mauve','melee','metre','mixte','monde','moral','motif','moyen','mulet','nappe','nette','neuve','noble','noeud','norme','noter','nuage','ocean','offre','orage','ordre','otage','ovule','oxyde','ozone','pacte','paire','palme','parmi','parti','pause','peine','pelle','pense','perdu','phase','piano','piece','pilot','place','plane','pleur','plier','plomb','plume','poeme','point','pompe','porte','poser','preux','prise','probe','prose','pulpe','purge','quete','queue','radar','ramen','rapid','rayon','rebut','recul','regle','reine','renne','repas','retro','rouge','roule','ruine','saint','salut','sauce','saule','scene','seche','selon','serre','siege','sobre','solar','solde','somme','sonde','sorte','souci','soupe','sourd','stade','style','suave','sucre','suite','super','surge','table','tabou','talon','tarif','taupe','terme','terre','titre','toile','tombe','toque','total','totem','train','trapu','trave','treve','tripe','troue','tuner','unite','utile','vague','valid','valse','valve','varan','vider','ville','viole','viral','vitre','vocal','voter','vouer','zeste'];
const FR_VALID_5  = FR_ANSWERS_5.concat(['abats','abord','agent','agres','aigle','alcov','alees','alise','allie','alpes','amble','amena','amend','amies','amuse','angel','areas','argon','argue','arles','arsis','atlas','avagy','avant','azote','babas','badge','banne','basin','basis','baste','beton','boise','bonus','bords','bouts','breve','bribe','brisa','brise','brous','bruts','buche','butes','cadet','canal','canes','canif','capon','capos','ceins','chats','chefs','chics','ciels','cirre','cites','comet','cornu','cosse','couds','coule','coups','cours','crams','creps','crime','crocs','crues','dalot','diois','doigt','doser','doute','ecran','eleve','empan','engel','epale','erose','fards','fauds','fetes','flot','fond','fous','froc','fume','gant','gars','gene','gite','glus','gout','gris','gros','grue','haie','hale','halo','hame','haut','heue','hier','hors','huer','huis','jamb','jarr','jete','joli','joue','juge','juif','jupe','jury','just','labs','lame','lard','lere','lieu','lire','lite','lobe','loco','loin','long','loue','loup','lune','lyse','mais','male','malt','mame','mane','manu','mare','maud','maus','mens','mere','mets','mile','mine','mise','mite','mode','mois','mole','mont','mort','moue','muge','mule','muse','muts','nage','naif','nard','narc','nare','naze','nere','nets','neuf','neve','nevi','nids','noir','noix','nome','nord','nors','nous','nuit','ocre','ogre','onde','onze','orge','orle','ossa','ours','pacs','page','paie','pain','pair','pale','pane','paon','parc','pare','parr','pars','part','pave','paye','peau','pedi','peon','pere','peri','pers','pier','pile','pine','pion','pipe','pire','plai','plie','plot','plus','pois','polo','pont','pore','port','pots','pour','prec','pret','pris','prof','prox','pugs','puma','puts','quai','rang','rape','rare','ravi','raze','rebe','recu','reel','reis','rend','rent','reve','rime','rire','rite','rive','robe','rode','role','roms','rond','rose','rota','roue','roux','rues','rugs','ruse','sacs','sage','sale','saur','secu','sein','sels','seme','sens','sire','site','soie','soif','soir','sols','some','sore','sort','sous','soue','spec','subs','suie','suis','surf','tale','tare','taxi','teme','tenu','test','tete','tige','tire','tirs','toit','tome','tone','tops','tors','tort','toue','tous','tout','trac','tram','tris','trop','trou','tube','tuee','turf','type','vain','vale','vars','veau','vege','velu','vent','vera','vers','vert','vide','vies','vifs','viol','visa','vise','vite','voie','voir','voix','vole','vols','volt','vomi','vote','voue','vrac','vrai','yeux','zinc','zone']);
const FR_FS_WORDS = ['abri','acte','aime','aire','alea','ange','arme','astre','bague','bande','bref','cafe','cage','calme','camp','cane','cave','chef','ciel','cime','cite','clin','clou','code','coin','comet','cord','cote','coup','cran','cure','dame','dard','date','demi','dent','dire','dome','droit','duel','dune','elan','elle','eros','etat','etre','fait','fame','fard','faux','fete','feux','fier','fils','fine','fini','flot','fond','fort','fume','gale','gant','gare','gars','gene','gite','gout','gris','gros','grue','haie','halo','haut','hier','hors','huer','jamb','jete','joli','joue','juge','jupe','just','lame','lard','lieu','lire','lobe','loin','long','loue','loup','lune','mais','male','malt','mare','mens','mere','mets','mile','mine','mise','mite','mode','mois','mole','mont','mort','moue','mule','muse','nage','naif','nard','neuf','neve','nids','noir','noix','nord','nous','nuit','ocre','ogre','onde','orge','ours','page','paie','pain','pair','pale','parc','pare','part','pave','peau','pere','pile','pion','pipe','plai','plie','plot','plus','pois','polo','pont','pore','port','pour','pret','pris','prof','quai','rang','rape','ravi','recu','reel','rend','reve','rime','rire','rite','rive','robe','rode','role','rond','rose','roue','roux','rues','ruse','sacs','sage','sale','sein','sels','seme','sens','site','soie','soif','soir','sols','sore','sort','sous','suie','surf','tale','tare','taxi','tenu','test','tete','tige','tire','toit','tome','tops','tort','tous','tout','trac','tram','trop','trou','tube','turf','type','vain','veau','velu','vent','vers','vert','vide','viol','visa','vite','voie','voir','voix','vole','volt','vote','voue','vrai','yeux','zinc','zone'];

// Language picker modal
const LANG_MODAL = `
<div class="lang-modal" id="langModal">
  <div class="lang-modal-box">
    <div class="lang-modal-title">🌍 Choose Language</div>
    <div class="lang-modal-sub">The interface and game words will change.</div>
    <div class="lang-options">
      <button class="lang-option" id="langOptEN" onclick="setLang('en')">
        <span class="lang-option-flag">🇬🇧</span>
        <span class="lang-option-info">
          <span class="lang-option-name">English</span>
          <span class="lang-option-desc">5-letter English words</span>
        </span>
        <span class="lang-option-check" id="langCheckEN">✓</span>
      </button>
      <button class="lang-option" id="langOptFR" onclick="setLang('fr')">
        <span class="lang-option-flag">🇫🇷</span>
        <span class="lang-option-info">
          <span class="lang-option-name">Français</span>
          <span class="lang-option-desc">Mots français de 5 lettres</span>
        </span>
        <span class="lang-option-check" id="langCheckFR">✓</span>
      </button>
    </div>
    <button class="lang-modal-close" onclick="closeLangModal()">Close / Fermer</button>
  </div>
</div>
<style>
.lang-modal{position:fixed;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(8px);z-index:700;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
.lang-modal.open{opacity:1;pointer-events:all}
.lang-modal-box{background:var(--s1);border:1px solid var(--bordm);border-radius:16px;padding:32px 28px;width:100%;max-width:380px;margin:16px}
.lang-modal-title{font-family:var(--fp);font-size:22px;font-weight:700;color:var(--fg);margin:0 0 6px}
.lang-modal-sub{font-size:13px;color:var(--fg2);margin:0 0 24px}
.lang-options{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}
.lang-option{display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:2px solid var(--border);background:var(--s2);cursor:pointer;transition:border-color .15s,background .15s;text-align:left;width:100%}
.lang-option:hover{border-color:var(--bordm);background:var(--s3)}
.lang-option.active{border-color:#f5d800;background:rgba(245,216,0,.08)}
.lang-option-flag{font-size:28px;flex-shrink:0}
.lang-option-info{display:flex;flex-direction:column;gap:2px;flex:1}
.lang-option-name{font-family:var(--fm);font-size:14px;font-weight:600;color:var(--fg)}
.lang-option-desc{font-size:11px;color:var(--fg3)}
.lang-option-check{font-size:16px;color:#f5d800;opacity:0;transition:opacity .15s}
.lang-option.active .lang-option-check{opacity:1}
.lang-modal-close{width:100%;background:transparent;border:1px solid var(--border);color:var(--fg2);border-radius:8px;padding:10px;font-family:var(--fm);font-size:12px;cursor:pointer;transition:border-color .15s}
.lang-modal-close:hover{border-color:var(--bordm);color:var(--fg)}
</style>
<script>
(function(){
  window.openLangModal = function(){
    var l=localStorage.getItem('bn_lang')||'en';
    document.getElementById('langOptEN').classList.toggle('active',l==='en');
    document.getElementById('langOptFR').classList.toggle('active',l==='fr');
    document.getElementById('langModal').classList.add('open');
  };
  window.closeLangModal = function(){
    document.getElementById('langModal').classList.remove('open');
  };
  window.setLang = function(l){
    localStorage.setItem('bn_lang',l);
    closeLangModal();
    window.location.reload();
  };
  document.getElementById('langModal').addEventListener('click',function(e){if(e.target===this)closeLangModal();});
})();

// Accent-insensitive normalize: strip diacritics, lowercase
function normalize(s){
  if(!s)return '';
  try{return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
  catch(e){return s.toLowerCase();}
}
</script>
`;


const PLAYER_MODAL = `<div class="modal-overlay" id="playerModal"><div class="modal"><h2>Your Name</h2><p>Shows on the leaderboard.</p><input type="text" id="playerNameInput" placeholder="e.g. Gaddaf" maxlength="20"/><button class="btn-primary" id="savePlayerName">Save</button></div></div>`;

const FRIEND_MODAL = `
<div class="invite-modal" id="inviteModal">
  <div class="invite-box">
    <div class="invite-title">👥 <span data-i18n="friend.title">Invite a Friend</span></div>
    <div class="invite-sub">Share Brainiacs with someone — challenge them on the same daily words!</div>
    <div class="invite-link-row">
      <input class="invite-link-input" id="inviteLinkInput" readonly value="https://brainiacs.app" />
      <button class="invite-copy-btn" id="inviteCopyBtn" onclick="copyInviteLink()"><span data-i18n="friend.copy">Copy</span></button>
    </div>
    <div class="invite-share-title"><span data-i18n="friend.sharedirectly">Share directly</span></div>
    <div class="invite-share-btns">
      <a class="share-btn" id="waShareBtn" href="#" target="_blank" rel="noopener">
        <span class="share-btn__icon">💬</span>
        <span class="share-btn__text"><span class="share-btn__label" data-i18n="friend.wa">WhatsApp</span><span class="share-btn__desc" data-i18n="friend.wa.desc">Send a message</span></span>
      </a>
      <a class="share-btn" id="emailShareBtn" href="#" target="_blank" rel="noopener">
        <span class="share-btn__icon">📧</span>
        <span class="share-btn__text"><span class="share-btn__label" data-i18n="friend.email">Email</span><span class="share-btn__desc" data-i18n="friend.email.desc">Send an invite</span></span>
      </a>
      <a class="share-btn" id="tgShareBtn" href="#" target="_blank" rel="noopener">
        <span class="share-btn__icon">✈️</span>
        <span class="share-btn__text"><span class="share-btn__label" data-i18n="friend.tg">Telegram</span><span class="share-btn__desc" data-i18n="friend.tg.desc">Share in chat</span></span>
      </a>
      <a class="share-btn" id="smsShareBtn" href="#" target="_blank" rel="noopener">
        <span class="share-btn__icon">📱</span>
        <span class="share-btn__text"><span class="share-btn__label" data-i18n="friend.sms">SMS / iMessage</span><span class="share-btn__desc" data-i18n="friend.sms.desc">Text a friend</span></span>
      </a>
      <a class="share-btn" id="twitterShareBtn" href="#" target="_blank" rel="noopener" style="grid-column:span 2">
        <span class="share-btn__icon">𝕏</span>
        <span class="share-btn__text"><span class="share-btn__label" data-i18n="friend.twitter">X / Twitter</span><span class="share-btn__desc" data-i18n="friend.twitter.desc">Post to your followers</span></span>
      </a>
    </div>
    <button class="invite-close" onclick="closeInviteModal()"><span data-i18n="friend.close">Close</span></button>
  </div>
</div>
<script>
(function(){
  function getInviteUrl(){
    return window.location.protocol+'//'+window.location.host;
  }
  window.openInviteModal = function(){
    var url = getInviteUrl();
    var msg = 'Play Brainiacs with me — daily word puzzles! ' + url;
    document.getElementById('inviteLinkInput').value = url;
    document.getElementById('waShareBtn').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
    document.getElementById('emailShareBtn').href = 'mailto:?subject=' + encodeURIComponent('Play Brainiacs with me!') + '&body=' + encodeURIComponent(msg);
    document.getElementById('tgShareBtn').href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent('Play Brainiacs with me — daily word puzzles!');
    document.getElementById('smsShareBtn').href = 'sms:?body=' + encodeURIComponent(msg);
    document.getElementById('twitterShareBtn').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(msg);
    document.getElementById('inviteModal').classList.add('open');
    // Reset copy button
    var cb = document.getElementById('inviteCopyBtn');
    cb.textContent = 'Copy'; cb.classList.remove('copied');
  };
  window.closeInviteModal = function(){
    document.getElementById('inviteModal').classList.remove('open');
  };
  window.copyInviteLink = function(){
    var url = document.getElementById('inviteLinkInput').value;
    navigator.clipboard.writeText(url).then(function(){
      var btn = document.getElementById('inviteCopyBtn');
      btn.textContent = '✓ Copied!'; btn.classList.add('copied');
      setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('copied'); }, 2000);
    }).catch(function(){
      document.getElementById('inviteLinkInput').select();
    });
  };
  // Close on backdrop click
  document.getElementById('inviteModal').addEventListener('click', function(e){
    if(e.target === this) window.closeInviteModal();
  });
})();
</script>
`;

function NAV(active, extra) {
  return `<nav class="navbar">
  <a class="navbar__logo" href="/"><span class="logo-icon">🧠</span><span class="logo-text">${BRAND}</span></a>
  <div class="navbar__links">
    <a href="/" class="nav-link${active==='home'?' active':''}" data-i18n="nav.games">Games</a>
    <a href="/rankings" class="nav-link${active==='rankings'?' active':''}" data-i18n="nav.rankings">Rankings</a>
    <a href="/badges" class="nav-link${active==='badges'?' active':''}" data-i18n="nav.badges">Badges</a>
  </div>
  <div class="navbar__right">
    <button class="lang-btn" id="langToggle" onclick="openLangModal()">
      <span id="langBtnFlag">🇬🇧</span>
      <span id="langBtnLabel" data-i18n="nav.language">Language</span>
    </button>
    <button class="friend-btn" id="friendBtn" onclick="openInviteModal()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
      <span data-i18n="nav.addfriend">Add a Friend</span>
    </button>
    <button class="navbar__player" id="playerBtn"><span id="playerName" data-i18n="nav.setname">Set Name</span></button>
    ${extra||''}
  </div>
  <!-- Hamburger (mobile only) -->
  <button class="nav-menu-btn" id="navMenuBtn" aria-label="Menu"><span></span><span></span><span></span></button>
</nav>
<!-- Mobile nav drawer -->
<div class="nav-drawer" id="navDrawer">
  <div class="nav-drawer__bd" id="navDrawerBd"></div>
  <div class="nav-drawer__panel">
    <button class="nav-drawer__close" id="navDrawerClose">×</button>
    <a href="/" class="nav-dlink${active==='home'?' active':''}">🎮 Games</a>
    <a href="/rankings" class="nav-dlink${active==='rankings'?' active':''}">🏆 Rankings</a>
    <a href="/badges" class="nav-dlink${active==='badges'?' active':''}">🏅 Badges</a>
    <div class="nav-drawer__sep"></div>
    <button class="nav-dlink clr-yellow" onclick="closeMobileNav();openLangModal()">🌍 Language</button>
    <button class="nav-dlink clr-white" onclick="closeMobileNav();openInviteModal()">👥 Add a Friend</button>
    <button class="nav-dlink clr-orange" id="drawerPlayerBtn"></button>
  </div>
</div>
<script>(function(){
  var btn=document.getElementById('navMenuBtn');
  var drawer=document.getElementById('navDrawer');
  var bd=document.getElementById('navDrawerBd');
  var closeBtn=document.getElementById('navDrawerClose');
  var drawerPlayerBtn=document.getElementById('drawerPlayerBtn');
  window.closeMobileNav=function(){drawer.classList.remove('open');};
  if(btn)btn.addEventListener('click',function(){drawer.classList.add('open');});
  if(bd)bd.addEventListener('click',window.closeMobileNav);
  if(closeBtn)closeBtn.addEventListener('click',window.closeMobileNav);
  // Sync player name in drawer
  function syncDrawerName(){var n=localStorage.getItem('bn_player');try{n=JSON.parse(n).name;}catch(e){}if(drawerPlayerBtn)drawerPlayerBtn.textContent='👤 '+(n||'Set Name');}
  syncDrawerName();
  if(drawerPlayerBtn)drawerPlayerBtn.addEventListener('click',function(){closeMobileNav();var pb=document.getElementById('playerBtn');if(pb)pb.click();});
})();</script>
<script>
(function(){
  var l=localStorage.getItem('bn_lang')||'en';
  var flagEl=document.getElementById('langBtnFlag');
  var labelEl=document.getElementById('langBtnLabel');
  if(flagEl) flagEl.textContent = l==='fr'?'🇫🇷':'🇬🇧';
  if(labelEl) labelEl.textContent = l==='fr'?'Langue':'Language';
})();
</script>`;
}


// ── HOME PAGE ──
function homePage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND} — Daily Brain Games</title>${FONTS}${CSS}
<style>
.hero{text-align:center;padding:40px 24px 28px;border-bottom:1px solid var(--border);background:radial-gradient(ellipse 70% 50% at 50% 0%,rgba(201,168,76,.07) 0%,transparent 70%)}
.hero__tag{font-family:var(--fm);font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:12px;display:inline-flex;align-items:center;gap:8px}
.hero__tag::before,.hero__tag::after{content:'';display:inline-block;width:24px;height:1px;background:var(--goldd)}
.hero__title{font-family:var(--fd);font-size:clamp(44px,8vw,82px);font-weight:900;letter-spacing:-.035em;line-height:.95;margin-bottom:10px;background:linear-gradient(160deg,var(--fg) 50%,var(--gold) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero__sub{font-size:14px;color:var(--fg2);max-width:280px;margin:0 auto;line-height:1.7}

.home-body{max-width:1100px;margin:0 auto;padding:40px 24px 72px;flex:1;width:100%;display:flex;gap:40px;align-items:flex-start}
.profile-panel{width:220px;flex-shrink:0;position:sticky;top:80px}
.profile-card{background:var(--s2);border:1px solid var(--border);border-radius:var(--rl);overflow:hidden;margin-bottom:16px}
.profile-card-header{background:#f5d800;border-bottom:2px solid #c9a800;padding:9px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.profile-card-header-text{font-family:var(--fm);font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#1a1400}
.profile-toggle{display:flex;gap:3px;background:rgba(0,0,0,.12);border-radius:4px;padding:2px}
.ptog{background:transparent;border:none;color:#1a1400;font-family:var(--fm);font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:4px 8px;border-radius:3px;cursor:pointer;transition:background .15s,color .15s;opacity:.6}
.ptog.active{background:#fff;opacity:1;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.ptog:hover:not(.active){opacity:.85}
.profile-card-body{padding:20px 18px 22px}
.profile-avatar{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--goldl));display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 10px;box-shadow:0 0 20px rgba(201,168,76,.3)}
.profile-name{font-family:var(--fd);font-size:16px;font-weight:700;text-align:center;margin-bottom:14px}
.profile-divider{border:none;border-top:1px solid var(--border);margin:14px 0}
.pstat-title{font-family:var(--fm);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#ffffff;margin-bottom:10px}
.pstat-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.pstat-label{font-size:11px;color:var(--fg2);display:flex;align-items:center;gap:6px}
.pstat-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.pstat-bar-wrap{flex:1;margin:0 8px;height:3px;background:var(--s3);border-radius:2px;overflow:hidden}
.pstat-bar{height:100%;border-radius:2px;width:0%;transition:width 1s cubic-bezier(.4,0,.2,1)}
.pstat-pct{font-family:var(--fm);font-size:10px;color:var(--fg2);min-width:26px;text-align:right}
.strength-label{font-family:var(--fm);font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:14px;margin-bottom:7px}
.strength-badge{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:4px;font-family:var(--fm);font-size:10px;font-weight:600;margin-bottom:5px}
.badge-str{background:#1e4d35;color:#6ddb96;border:1px solid #3a8f5e;text-shadow:0 0 8px rgba(109,219,150,.3)}
.badge-weak{background:#4a1a1a;color:#ff7070;border:1px solid #8f3a3a;text-shadow:0 0 8px rgba(255,112,112,.25)}

.games-area{flex:1;min-width:0}
.section-label{font-family:var(--fm);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--fg3);text-align:center;margin-bottom:36px}

.camembert-layout{display:flex;align-items:center;justify-content:center;gap:48px;flex-wrap:wrap}
.pie-wrap{position:relative;flex-shrink:0}
.pie-svg{display:block;overflow:visible;filter:drop-shadow(0 8px 40px rgba(0,0,0,.6))}
.pie-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.pie-center__icon{font-size:28px;line-height:1;margin-bottom:4px}
.pie-center__label{font-family:var(--fm);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg2);transition:color .2s}
.game-legend{display:flex;flex-direction:column;gap:10px;min-width:220px}
.legend-item{display:flex;align-items:flex-start;gap:12px;padding:11px 14px;border-radius:var(--rm);border:1px solid transparent;transition:border-color .2s,background .2s,transform .2s;text-decoration:none!important;color:var(--fg)}
.legend-item:not(.legend-item--disabled){cursor:pointer}
.legend-item:not(.legend-item--disabled):hover,.legend-item.active{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.09);transform:translateX(5px)}
.legend-item--disabled{opacity:.38;cursor:default}
.legend-item--disabled:hover{transform:none!important;background:transparent!important;border-color:transparent!important}
.legend-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;margin-top:4px}
.legend-info{flex:1}
.legend-name{font-family:var(--fd);font-size:26px;font-weight:700;line-height:1.1;margin-bottom:2px}
.legend-desc{font-size:11px;color:var(--fg2);line-height:1.5}
.legend-badge{font-family:var(--fm);font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 6px;border-radius:2px;flex-shrink:0;margin-top:3px}

@media(max-width:900px){.home-body{flex-direction:column}.profile-panel{width:100%;position:static}.camembert-layout{gap:28px}}
</style>
</head><body>
${AD_TOP}${NAV('home')}
<header class="hero">
  <div class="hero__tag">Daily Brain Games</div>
  <h1 class="hero__title">${BRAND}</h1>
  <p class="hero__sub">${TAGLINE}</p>
</header>
<main class="home-body">

  <!-- LEFT: PROFILE PANEL -->
  <aside class="profile-panel">
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-card-header-text">Your Brainiac</span>
        <div class="profile-toggle">
          <button class="ptog active" id="togStats">Stats</button>
          <button class="ptog" id="togRank">Rank</button>
        </div>
      </div>
      <div class="profile-card-body">
      <div class="profile-avatar" id="profileAvatar">🧠</div>
      <div class="profile-name" id="profileName">Anonymous</div>
      <hr class="profile-divider">
      <div id="statsView">
      <div class="pstat-title">Success Rate</div>
      <div id="skillRadar">
        <div class="pstat-row">
          <span class="pstat-label"><span class="pstat-dot" style="background:#e05c5c"></span><span data-i18n="wordle.title">Wordle</span></span>
          <div class="pstat-bar-wrap"><div class="pstat-bar" id="pb-wordle" style="background:#e05c5c"></div></div>
          <span class="pstat-pct" id="pp-wordle">—</span>
        </div>
        <div class="pstat-row">
          <span class="pstat-label"><span class="pstat-dot" style="background:#5b9cf6"></span><span data-i18n="pathle.title">Pathle</span></span>
          <div class="pstat-bar-wrap"><div class="pstat-bar" id="pb-pathle" style="background:#5b9cf6"></div></div>
          <span class="pstat-pct" id="pp-pathle">—</span>
        </div>
        <div class="pstat-row">
          <span class="pstat-label"><span class="pstat-dot" style="background:#f5a623"></span><span data-i18n="fs.title">FastSpell</span></span>
          <div class="pstat-bar-wrap"><div class="pstat-bar" id="pb-fastspell" style="background:#f5a623"></div></div>
          <span class="pstat-pct" id="pp-fastspell">—</span>
        </div>
        <div class="pstat-row">
          <span class="pstat-label"><span class="pstat-dot" style="background:#a06bf5"></span><span data-i18n="blindle.title">Blindle</span></span>
          <div class="pstat-bar-wrap"><div class="pstat-bar" id="pb-blindle" style="background:#a06bf5"></div></div>
          <span class="pstat-pct" id="pp-blindle">—</span>
        </div>
      </div>
      <div id="strengthBox" style="display:none">
        <div class="strength-label" style="color:#6ddb96">🏆 Strengths</div>
        <div id="strengthList"></div>
        <div class="strength-label" style="color:#ff7070;margin-top:8px">🎯 To improve</div>
        <div id="weakList"></div>
      </div>
      </div>
      <div id="rankView" style="display:none">
        <div class="pstat-title" style="color:var(--gold)">Rank Percentile</div>
        <div id="rankRadar">
          <div class="pstat-row">
            <span class="pstat-label"><span class="pstat-dot" style="background:#e05c5c"></span>Wordle</span>
            <div class="pstat-bar-wrap"><div class="pstat-bar" id="rb-wordle" style="background:linear-gradient(90deg,var(--gold),var(--goldl))"></div></div>
            <span class="pstat-pct" id="rp-wordle">—</span>
          </div>
          <div class="pstat-row">
            <span class="pstat-label"><span class="pstat-dot" style="background:#5b9cf6"></span>Pathle</span>
            <div class="pstat-bar-wrap"><div class="pstat-bar" id="rb-pathle" style="background:linear-gradient(90deg,var(--gold),var(--goldl))"></div></div>
            <span class="pstat-pct" id="rp-pathle">—</span>
          </div>
          <div class="pstat-row">
            <span class="pstat-label"><span class="pstat-dot" style="background:#f5a623"></span>FastSpell</span>
            <div class="pstat-bar-wrap"><div class="pstat-bar" id="rb-fastspell" style="background:linear-gradient(90deg,var(--gold),var(--goldl))"></div></div>
            <span class="pstat-pct" id="rp-fastspell">—</span>
          </div>
          <div class="pstat-row">
            <span class="pstat-label"><span class="pstat-dot" style="background:#a06bf5"></span>Blindle</span>
            <div class="pstat-bar-wrap"><div class="pstat-bar" id="rb-blindle" style="background:linear-gradient(90deg,var(--gold),var(--goldl))"></div></div>
            <span class="pstat-pct" id="rp-blindle">—</span>
          </div>
        </div>
      </div>
      </div>
    </div>
  </aside>

  <!-- RIGHT: PIE CHART -->
  <div class="games-area">
    <div class="section-label"><span data-i18n="home.choose">Choose your skill to train</span></div>
    <div class="camembert-layout">
      <div class="pie-wrap" style="width:280px;height:280px" id="pieContainer">
        <svg class="pie-svg" id="pieSvg" width="280" height="280" viewBox="-10 -10 220 220"></svg>
        <div class="pie-center">
          <div class="pie-center__icon" id="pieCenterIcon">🧠</div>
          <div class="pie-center__label" id="pieCenterLabel">Pick a game</div>
        </div>
      </div>
      <div class="game-legend" id="gameLegend">
        <a href="/wordle" class="legend-item" data-idx="0" id="leg0">
          <div class="legend-dot" style="background:#e05c5c"></div>
          <div class="legend-info">
            <div class="legend-name" style="color:#e05c5c">Wordle</div>
            <div class="legend-desc" data-i18n="home.wordle.desc">Crack the 5-letter word in 6 tries.<br>Vocabulary &amp; deduction.</div>
          </div>
        </a>
        <a href="/pathle" class="legend-item" data-idx="1" id="leg1">
          <div class="legend-dot" style="background:#5b9cf6"></div>
          <div class="legend-info">
            <div class="legend-name" style="color:#5b9cf6">Pathle</div>
            <div class="legend-desc" data-i18n="home.pathle.desc">Transform one word into another, one letter at a time.<br>Logic &amp; vocabulary.</div>
          </div>
        </a>
        <a href="/fastspell" class="legend-item" data-idx="2" id="leg2">
          <div class="legend-dot" style="background:#f5a623"></div>
          <div class="legend-info">
            <div class="legend-name" style="color:#f5a623">FastSpell</div>
            <div class="legend-desc" data-i18n="home.fs.desc">Build words from 7 letters. The centre letter is mandatory.<br>Word power &amp; speed.</div>
          </div>
        </a>
        <a href="/blindle" class="legend-item" data-idx="3" id="leg3">
          <div class="legend-dot" style="background:#a06bf5"></div>
          <div class="legend-info">
            <div class="legend-name" style="color:#a06bf5">Blindle</div>
            <div class="legend-desc" data-i18n="home.blindle.desc">Guess the word in 9 tries — but you only see counts.<br>Deduction without hints.</div>
          </div>
        </a>
      </div>
    </div>
  </div>
</main>
${AD_BOT}${FOOTER}${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<script>
(function() {
  var _t=window._T||{};
  var GAMES = [
    { color:'#e05c5c', label:'Wordle',    icon:'🟩', desc:_t['game.wordle.desc']||'Vocabulary',   pct:0.25, id:'wordle' },
    { color:'#5b9cf6', label:'Pathle',    icon:'🔗', desc:_t['game.pathle.desc']||'Logic',        pct:0.25, id:'pathle' },
    { color:'#f5a623', label:'FastSpell', icon:'💡', desc:_t['game.fastspell.desc']||'Word Power', pct:0.25, id:'fastspell' },
    { color:'#a06bf5', label:'Blindle',   icon:'🔮', desc:_t['game.blindle.desc']||'Blind Guess', pct:0.25, id:'blindle' }
  ];
  var NS='http://www.w3.org/2000/svg', svg=document.getElementById('pieSvg');
  var CX=100, CY=100, R=90, GAP_DEG=2.5, hovered=-1;
  var pieContainer = document.getElementById('pieContainer');

  function pt(r,a){return [CX+r*Math.cos(a),CY+r*Math.sin(a)];}
  function arc(s,e,r){var large=(e-s)>Math.PI?1:0,sp=pt(r,s),ep=pt(r,e);return 'M '+CX+' '+CY+' L '+sp[0].toFixed(2)+' '+sp[1].toFixed(2)+' A '+r+' '+r+' 0 '+large+' 1 '+ep[0].toFixed(2)+' '+ep[1].toFixed(2)+' Z';}

  function build(){
    svg.innerHTML='';
    var LINKS=['/wordle','/pathle','/fastspell','/blindle'];
    var total=GAMES.reduce(function(a,g){return a+g.pct;},0);
    var GAP=GAP_DEG*Math.PI/180, totalGap=GAP*GAMES.length, angle=-Math.PI/2;
    GAMES.forEach(function(g,i){
      var span=(g.pct/total)*(2*Math.PI-totalGap);
      var p=document.createElementNS(NS,'path');
      p.setAttribute('d',arc(angle,angle+span,R));
      p.setAttribute('fill',g.color);
      p.setAttribute('opacity','0.88');
      p.setAttribute('data-angle',angle);
      p.setAttribute('data-span',span);
      p.setAttribute('data-idx',i);
      p.setAttribute('style','cursor:pointer;transition:opacity .2s,transform .25s cubic-bezier(.34,1.4,.64,1)');
      p.onmouseenter=function(){updateHover(i);};
      p.onclick=function(){window.location.href=LINKS[i];};
      svg.appendChild(p);
      angle+=span+GAP;
    });
    // Center hole — pointer-events:none so clicks pass through to slices
    var h=document.createElementNS(NS,'circle');
    h.setAttribute('cx',CX);h.setAttribute('cy',CY);h.setAttribute('r',38);
    h.setAttribute('fill','#0f0f0f');
    h.style.pointerEvents='none';
    svg.appendChild(h);
    var hr=document.createElementNS(NS,'circle');
    hr.setAttribute('cx',CX);hr.setAttribute('cy',CY);hr.setAttribute('r',38);
    hr.setAttribute('fill','none');hr.setAttribute('stroke','#242424');hr.setAttribute('stroke-width','1.5');
    hr.style.pointerEvents='none';
    svg.appendChild(hr);
  }

  function updateHover(i){
    hovered=i;
    var paths=svg.querySelectorAll('path[data-idx]');
    paths.forEach(function(p){
      var idx=parseInt(p.getAttribute('data-idx'));
      var isH=(idx===i);
      var angle=parseFloat(p.getAttribute('data-angle'));
      var span=parseFloat(p.getAttribute('data-span'));
      var mid=angle+span/2;
      p.setAttribute('opacity', i<0?'0.88':(isH?'1':'0.42'));
      if(isH){
        var grow=10;
        var ox=(grow*Math.cos(mid)).toFixed(2), oy=(grow*Math.sin(mid)).toFixed(2);
        p.setAttribute('transform','translate('+ox+','+oy+')');
      } else {
        p.setAttribute('transform','translate(0,0)');
      }
    });
    var ci=document.getElementById('pieCenterIcon'), cl=document.getElementById('pieCenterLabel');
    if(i>=0){ci.textContent=GAMES[i].icon;cl.textContent=GAMES[i].desc;cl.style.color=GAMES[i].color;}
    else{ci.textContent='🧠';cl.textContent='Pick a game';cl.style.color='';}
  }

  // Event delegation on SVG — fires reliably even when attributes change
  svg.addEventListener('mousemove', function(e){
    var p=e.target.closest?e.target.closest('path[data-idx]'):e.target;
    if(p&&p.hasAttribute('data-idx')){updateHover(parseInt(p.getAttribute('data-idx')));}
    else{updateHover(-1);}
  });
  svg.addEventListener('mouseleave', function(){ updateHover(-1); });
  pieContainer.addEventListener('mouseleave', function(){ updateHover(-1); });


  // Legend hover sync
  GAMES.forEach(function(_,i){
    var el=document.getElementById('leg'+i);
    if(!el)return;
    el.addEventListener('mouseenter',function(){updateHover(i);});
    el.addEventListener('mouseleave',function(){updateHover(-1);});
  });

  // Profile stats + toggle
  document.addEventListener('DOMContentLoaded', function(){
    var nm=Player.getName();
    if(nm){document.getElementById('profileName').textContent=nm;document.getElementById('profileAvatar').textContent=nm[0].toUpperCase();}
    var games=[{id:'wordle',label:'Wordle'},{id:'pathle',label:'Pathle'},{id:'fastspell',label:'FastSpell'},{id:'blindle',label:'Blindle'}];
    var scores=[], hasAny=false;
    setTimeout(function(){
      games.forEach(function(g){
        var s=GameStats.getStats(g.id);
        var wr=s.played>0?GameStats.getWinRate(s):null;
        scores.push({g:g,wr:wr});
        if(s.played>0) hasAny=true;
        var bar=document.getElementById('pb-'+g.id);
        var pct=document.getElementById('pp-'+g.id);
        if(bar&&wr!==null){bar.style.width=wr+'%';pct.textContent=wr+'%';}
      });
      if(hasAny){
        var played=scores.filter(function(x){return x.wr!==null;});
        played.sort(function(a,b){return b.wr-a.wr;});
        var strong=played.slice(0,1), weak=played.slice(-1);
        var sb=document.getElementById('strengthBox');
        if(sb&&played.length){
          sb.style.display='block';
          var sl=document.getElementById('strengthList');
          var wl=document.getElementById('weakList');
          if(sl) sl.innerHTML=strong.map(function(x){return '<div class="strength-badge badge-str">'+x.g.label+' — top '+Math.max(1,100-Math.round(x.wr))+'%</div>';}).join('');
          if(wl) wl.innerHTML=weak.map(function(x){return '<div class="strength-badge badge-weak">'+x.g.label+' — needs work</div>';}).join('');
        }
      }
    },80);

    // Toggle Stats / Rank
    var togStats=document.getElementById('togStats');
    var togRank=document.getElementById('togRank');
    var statsView=document.getElementById('statsView');
    var rankView=document.getElementById('rankView');
    var rankLoaded=false;
    function showStats(){statsView.style.display='';rankView.style.display='none';togStats.classList.add('active');togRank.classList.remove('active');}
    function showRank(){statsView.style.display='none';rankView.style.display='';togStats.classList.remove('active');togRank.classList.add('active');if(!rankLoaded){rankLoaded=true;loadRankings();}}
    togStats.addEventListener('click',showStats);
    togRank.addEventListener('click',showRank);

    function loadRankings(){
      var myUid=BnSync.uid();
      games.forEach(function(g){
        fetch('/api/rankings?game='+g.id)
          .then(function(r){return r.ok?r.json():[];})
          .then(function(rows){
            var bar=document.getElementById('rb-'+g.id);
            var lbl=document.getElementById('rp-'+g.id);
            if(!bar||!lbl)return;
            var idx=rows.findIndex(function(r){return r.playerId===myUid;});
            if(idx===-1||!myUid){lbl.textContent='—';return;}
            var rank=idx+1, N=rows.length;
            var fill=Math.round((1-(rank-1)/Math.max(1,N))*100);
            var suffix=rank===1?'st':rank===2?'nd':rank===3?'rd':'th';
            bar.style.width=fill+'%';
            lbl.textContent=rank+suffix;
            lbl.title='Rank '+rank+' of '+N+' players';
          })
          .catch(function(){});
      });
    }
  });

  build();
})();
</script>
</body></html>`;
}

// ── RANKINGS PAGE ──
function rankingsPage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rankings — ${BRAND}</title>${FONTS}${CSS}
<style>
.rk-main{max-width:820px;margin:0 auto;padding:52px 24px 72px;flex:1;width:100%}
.rk-header{margin-bottom:36px;border-bottom:1px solid var(--border);padding-bottom:28px}
.rk-header h1{font-family:var(--fd);font-size:clamp(34px,5vw,52px);font-weight:900;letter-spacing:-.025em;margin-bottom:8px;background:linear-gradient(130deg,var(--fg) 50%,var(--gold) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.rk-header p{color:var(--fg2);font-size:14px}
.tabs{display:flex;gap:4px;margin-bottom:26px;border-bottom:1px solid var(--border)}
.tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--fg2);font-family:var(--fm);font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:9px 18px 11px;cursor:pointer;margin-bottom:-1px;transition:color .15s,border-color .15s}
.tab:hover{color:var(--fg)}.tab.active{color:var(--gold);border-bottom-color:var(--gold)}
.table-wrap{overflow-x:auto;border-radius:var(--rl);border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-family:var(--fm);font-size:13px}
thead{background:var(--s2)}
th{text-align:left;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg2);padding:13px 18px;border-bottom:1px solid var(--border);font-weight:400}
tbody tr{border-bottom:1px solid var(--border);transition:background .12s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:var(--s2)}
td{padding:16px 18px;vertical-align:middle}
.rn{font-family:var(--fd);font-weight:700;font-size:20px;color:var(--fg2)}
.rn.g{color:#ffd700;text-shadow:0 0 12px rgba(255,215,0,.4)}.rn.s{color:#c0c0c0}.rn.b{color:#cd7f32}
.pc{display:flex;align-items:center;gap:12px}
.av{width:30px;height:30px;background:var(--s3);border:1px solid var(--bordm);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--gold);font-weight:500;flex-shrink:0}
.you{font-size:9px;color:var(--gold);letter-spacing:.1em;text-transform:uppercase;background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.2);padding:2px 7px;border-radius:2px}
.wp{color:var(--greenl);font-weight:500}.ag{color:var(--gold)}
.empty{text-align:center;color:var(--fg2);padding:48px!important;font-size:14px}
.note{margin-top:24px;font-family:var(--fm);font-size:11px;color:var(--fg3);line-height:1.7;border-left:2px solid var(--bordm);padding-left:16px}

.badge-card{background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:18px 16px;display:flex;flex-direction:column;gap:8px;transition:border-color .2s}
.badge-card.earned{border-color:#c9a84c;background:linear-gradient(135deg,var(--s2),rgba(201,168,76,.08))}
.badge-card.locked{opacity:.55}
.badge-icon{font-size:32px;line-height:1}
.badge-name{font-family:var(--fp);font-size:14px;font-weight:600;color:var(--fg)}
.badge-desc{font-size:11px;color:var(--fg3);line-height:1.5}
.badge-prog{margin-top:4px}
.badge-prog-bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-top:4px}
.badge-prog-fill{height:100%;background:#c9a84c;border-radius:2px;transition:width .4s}
.badge-prog-label{font-size:10px;color:var(--fg3);letter-spacing:.06em}
.badge-earned-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#c9a84c;font-weight:600}
.badge-section-title{grid-column:1/-1;font-family:var(--fp);font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg3);padding:12px 0 4px;border-bottom:1px solid var(--border)}</style>
</head><body>
${AD_TOP}${NAV('rankings')}
<main class="rk-main">
  <div class="rk-header"><h1><span data-i18n="home.globalrankings">Global Rankings</span></h1><p>Sorted by win ratio, then average guesses on wins.</p></div>
  <div class="tabs">
    <button class="tab active" data-game="wordle">🟩 Wordle</button>
    <button class="tab" data-game="pathle">🔗 Pathle</button>
    <button class="tab" data-game="fastspell">💡 FastSpell</button>
    <button class="tab" data-game="blindle">🔮 Blindle</button>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>#</th><th><span data-i18n="rankings.player">Player</span></th><th><span data-i18n="rankings.played">Played</span></th><th><span data-i18n="rankings.winrate">Win %</span></th><th><span data-i18n="wordle.avgguesses">Avg Guesses</span></th><th><span data-i18n="wordle.maxstreak">Max Streak</span></th></tr></thead>
    <tbody id="tbody"><tr><td colspan="6" class="empty">No players yet — play a game first!</td></tr></tbody>
  </table></div>
  <p class="note" id="rankNote">Loading global rankings…</p>
</main>
${AD_BOT}${FOOTER}${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<script>
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderRankings(gameId) {
  var note = document.getElementById('rankNote');
  var tbody = document.getElementById('tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
  BnSync.fetchRankings(gameId, function(rows) {
    var myUid = BnSync.uid();
    var cur = Player.getOrCreate();
    if (note) {
      if (myUid) note.textContent = 'Real-time global rankings — updated after each game.';
      else note.textContent = 'Rankings are stored in your browser (no database configured).';
    }
    if (!rows.length) { tbody.innerHTML='<tr><td colspan="6" class="empty">No players yet — play a game first!</td></tr>'; return; }
    tbody.innerHTML = rows.map(function(e, i) {
      var r=i+1, rc=r===1?'g':r===2?'s':r===3?'b':'';
      var wp=e.played>0?Math.round(e.wins/e.played*100):0;
      var ag=e.wins>0?(e.totalGuessesOnWin/e.wins).toFixed(2):'—';
      var isYou = myUid ? e.playerId===myUid : e.playerId===cur.id;
      var init=(e.name||'?')[0].toUpperCase();
      return '<tr><td><span class="rn '+rc+'">'+r+'</span></td>'+
        '<td><div class="pc"><div class="av">'+init+'</div><span>'+esc(e.name||'Anonymous')+'</span>'+(isYou?'<span class="you">You</span>':'')+'</div></td>'+
        '<td>'+e.played+'</td><td><span class="wp">'+wp+'%</span></td><td><span class="ag">'+ag+'</span></td><td>'+e.maxStreak+'</td></tr>';
    }).join('');
  });
}
// ── BADGE SYSTEM ──────────────────────────────────────────────────────────
var BADGE_DEFS = [
  // ── Games Played ──────────────────────────────────────────────────────
  {id:'first_step',   cat:'First Steps',   icon:'👣', name:'First Step',      desc:'Play your first game of any kind',       check:function(s){return s.any_played>=1;},   max:1},
  {id:'regular',      cat:'First Steps',   icon:'📅', name:'Regular',         desc:'Play 7 games total',                     check:function(s){return s.any_played>=7;},   max:7},
  {id:'devoted',      cat:'First Steps',   icon:'🗓', name:'Devoted',         desc:'Play 30 games total',                    check:function(s){return s.any_played>=30;},  max:30},
  {id:'centurion',    cat:'First Steps',   icon:'💯', name:'Centurion',       desc:'Play 100 games total',                   check:function(s){return s.any_played>=100;}, max:100},
  {id:'wordle_fan',   cat:'First Steps',   icon:'🟩', name:'Wordle Fan',      desc:'Play 20 Wordle games',                   check:function(s){return s.w_played>=20;},    max:20},
  {id:'pathle_fan',   cat:'First Steps',   icon:'🔗', name:'Pathfinder',      desc:'Play 20 Pathle games',                   check:function(s){return s.p_played>=20;},    max:20},
  {id:'spell_fan',    cat:'First Steps',   icon:'💡', name:'Spellbound',      desc:'Play 20 FastSpell games',                check:function(s){return s.f_played>=20;},    max:20},
  {id:'blind_fan',    cat:'First Steps',   icon:'🔮', name:'Blindfolded',     desc:'Play 20 Blindle games',                  check:function(s){return s.b_played>=20;},    max:20},
  // ── Win Rate ──────────────────────────────────────────────────────────
  {id:'first_win',    cat:'Victories',     icon:'🥇', name:'First Win',       desc:'Win your first game',                    check:function(s){return s.any_wins>=1;},     max:1},
  {id:'win_streak_3', cat:'Victories',     icon:'🔥', name:'Hat Trick',       desc:'Win 3 games in a row (any game)',        check:function(s){return s.any_streak>=3;},   max:3},
  {id:'win_streak_7', cat:'Victories',     icon:'🏆', name:'On Fire',         desc:'Win 7 games in a row (any game)',        check:function(s){return s.any_streak>=7;},   max:7},
  {id:'wordle_ace',   cat:'Victories',     icon:'⚡', name:'Wordle Ace',      desc:'Win 10 Wordle games',                    check:function(s){return s.w_wins>=10;},      max:10},
  {id:'perfect_w',    cat:'Victories',     icon:'🎯', name:'Sharp Mind',      desc:'Solve Wordle in 2 guesses',              check:function(s){return s.w_best_guesses<=2&&s.w_best_guesses>0;}, max:1},
  {id:'blind_win',    cat:'Victories',     icon:'🦇', name:'Blind Win',       desc:'Win a Blindle game',                     check:function(s){return s.b_wins>=1;},       max:1},
  {id:'blind_ace',    cat:'Victories',     icon:'🌑', name:'Blind Ace',       desc:'Win 10 Blindle games',                   check:function(s){return s.b_wins>=10;},      max:10},
  // ── FastSpell ─────────────────────────────────────────────────────────
  {id:'spell_10',     cat:'FastSpell',     icon:'🔡', name:'Getting Started', desc:'Score 10 points in FastSpell',           check:function(s){return s.f_best>=10;},      max:10},
  {id:'spell_50',     cat:'FastSpell',     icon:'✨', name:'Spell Caster',    desc:'Score 50 points in FastSpell',           check:function(s){return s.f_best>=50;},      max:50},
  {id:'spell_100',    cat:'FastSpell',     icon:'🌟', name:'Wizard',          desc:'Score 100 points in FastSpell',          check:function(s){return s.f_best>=100;},     max:100},
  {id:'pangram',      cat:'FastSpell',     icon:'💎', name:'Pangram Hunter',  desc:'Find a pangram in FastSpell',            check:function(s){return s.f_pangrams>=1;},   max:1},
  // ── Dedication ────────────────────────────────────────────────────────
  {id:'all_four',     cat:'Dedication',    icon:'🃏', name:'All In',          desc:'Play all 4 games at least once',         check:function(s){return s.w_played>=1&&s.p_played>=1&&s.f_played>=1&&s.b_played>=1;}, max:4},
  {id:'completionist',cat:'Dedication',    icon:'🎖', name:'Completionist',   desc:'Win at least one game in all 4 modes',   check:function(s){return s.w_wins>=1&&s.p_wins>=1&&s.f_played>=1&&s.b_wins>=1;}, max:4},
  {id:'veteran',      cat:'Dedication',    icon:'🧙', name:'Veteran',         desc:'Play 50 total games across all modes',   check:function(s){return s.any_played>=50;},  max:50},
  {id:'legend',       cat:'Dedication',    icon:'👑', name:'Legend',          desc:'Play 200 total games across all modes',  check:function(s){return s.any_played>=200;}, max:200},
];

function getBadgeStats() {
  var def = function(){return {played:0,wins:0,maxStreak:0,totalGuessesOnWin:0,distribution:{}};};
  var w = GameStats.getStats('wordle');
  var p = GameStats.getStats('pathle');
  var f = GameStats.getStats('fastspell');
  var b = GameStats.getStats('blindle');
  // Best guesses for Wordle (lowest non-zero distribution key with count > 0)
  var wbg = 0;
  [1,2,3,4,5,6].forEach(function(n){ if((w.distribution[n]||0)>0 && (!wbg||n<wbg)) wbg=n; });
  // FastSpell best score from localStorage
  var fBest = 0, fPangrams = 0;
  try { var fd=JSON.parse(localStorage.getItem('bn_stats_fastspell')||'{}'); fBest=fd.bestScore||0; fPangrams=fd.pangrams||0; } catch(e){}
  return {
    w_played: w.played, w_wins: w.wins, w_streak: w.maxStreak, w_best_guesses: wbg,
    p_played: p.played, p_wins: p.wins,
    f_played: f.played, f_best: fBest, f_pangrams: fPangrams,
    b_played: b.played, b_wins: b.wins,
    any_played: w.played+p.played+f.played+b.played,
    any_wins: w.wins+p.wins+b.wins,
    any_streak: Math.max(w.maxStreak, p.maxStreak, b.maxStreak),
  };
}

function getBadgeProgress(badge, stats) {
  // Map badge to a numeric progress 0..max
  var prog = 0;
  if(badge.id==='first_step'||badge.id==='regular'||badge.id==='devoted'||badge.id==='centurion'||badge.id==='veteran'||badge.id==='legend') prog=stats.any_played;
  else if(badge.id==='wordle_fan') prog=stats.w_played;
  else if(badge.id==='pathle_fan') prog=stats.p_played;
  else if(badge.id==='spell_fan') prog=stats.f_played;
  else if(badge.id==='blind_fan') prog=stats.b_played;
  else if(badge.id==='first_win'||badge.id==='wordle_ace') prog=stats.any_wins;
  else if(badge.id==='blind_win'||badge.id==='blind_ace') prog=stats.b_wins;
  else if(badge.id==='win_streak_3'||badge.id==='win_streak_7') prog=stats.any_streak;
  else if(badge.id==='spell_10'||badge.id==='spell_50'||badge.id==='spell_100') prog=stats.f_best;
  else if(badge.id==='pangram') prog=stats.f_pangrams;
  else if(badge.id==='all_four') prog=(stats.w_played>=1?1:0)+(stats.p_played>=1?1:0)+(stats.f_played>=1?1:0)+(stats.b_played>=1?1:0);
  else if(badge.id==='completionist') prog=(stats.w_wins>=1?1:0)+(stats.p_wins>=1?1:0)+(stats.f_played>=1?1:0)+(stats.b_wins>=1?1:0);
  else if(badge.id==='perfect_w') prog=stats.w_best_guesses>0&&stats.w_best_guesses<=2?1:0;
  return Math.min(prog, badge.max);
}

function renderBadges() {
  var grid = document.getElementById('badgesGrid');
  if(!grid) return;
  var stats = getBadgeStats();
  // Group by category
  var cats = [], catMap = {};
  BADGE_DEFS.forEach(function(b){
    if(!catMap[b.cat]){catMap[b.cat]=[];cats.push(b.cat);}
    catMap[b.cat].push(b);
  });
  var html = '';
  cats.forEach(function(cat){
    html += '<div class="badge-section-title">'+cat+'</div>';
    catMap[cat].forEach(function(b){
      var earned = b.check(stats);
      var prog = getBadgeProgress(b, stats);
      var pct = Math.round((prog/b.max)*100);
      html += '<div class="badge-card '+(earned?'earned':'locked')+'">';
      html += '<div class="badge-icon">'+(earned?b.icon:'🔒')+'</div>';
      html += '<div class="badge-name">'+b.name+'</div>';
      html += '<div class="badge-desc">'+b.desc+'</div>';
      if(earned){
        html += '<div class="badge-earned-label">✓ Earned</div>';
      } else {
        html += '<div class="badge-prog"><div class="badge-prog-label">'+prog+' / '+b.max+'</div>';
        html += '<div class="badge-prog-bar"><div class="badge-prog-fill" style="width:'+pct+'%"></div></div></div>';
      }
      html += '</div>';
    });
  });
  grid.innerHTML = html;
}

document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){
    document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
    t.classList.add('active');
    renderRankings(t.dataset.game);
  });
});
document.addEventListener('DOMContentLoaded', function(){ renderRankings('wordle'); });
</script>
</body></html>`;
}

// ── WORDLE PAGE ──
function wordlePage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wordle — ${BRAND}</title>${FONTS}${CSS}
<style>
.gh{text-align:center;padding:24px 16px 16px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(201,168,76,.04),transparent)}
.gt{font-family:var(--fd);font-size:34px;font-weight:900;letter-spacing:-.02em;background:linear-gradient(135deg,var(--fg) 30%,var(--gold) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.gs{font-family:var(--fm);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg2);margin-top:4px}
.gm{display:flex;align-items:center;justify-content:center;margin-top:8px;font-family:var(--fm);font-size:11px;color:var(--fg3)}
.game-main{display:flex;flex-direction:column;align-items:center;padding:24px 16px 36px;gap:22px;flex:1}
.board{display:grid;grid-template-rows:repeat(6,1fr);gap:6px}
.row{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.tile{width:var(--tile-sz,60px);height:var(--tile-sz,60px);border:2px solid var(--bordm);display:flex;align-items:center;justify-content:center;font-family:var(--fm);font-size:var(--tile-fs,26px);font-weight:700;text-transform:uppercase;color:#ffffff;background:transparent;user-select:none;border-radius:2px;transition:border-color .08s}
.tile.filled{border-color:#484030}
.tile.pop{animation:tPop .12s ease}
@keyframes tPop{0%{transform:scale(1)}50%{transform:scale(1.1)}100%{transform:scale(1)}}
.row.shake{animation:rShake .42s ease}
@keyframes rShake{0%,100%{transform:translateX(0)}18%{transform:translateX(-7px)}36%{transform:translateX(7px)}54%{transform:translateX(-5px)}72%{transform:translateX(5px)}}
.tile.flip{animation:tFlip .5s ease forwards}
@keyframes tFlip{0%{transform:rotateX(0)}49%{transform:rotateX(90deg);background:transparent;border-color:var(--bordm)}50%{transform:rotateX(90deg)}100%{transform:rotateX(0)}}
.tile.correct{background:var(--correct);border-color:var(--correct);color:#ffffff}
.tile.present{background:var(--present);border-color:var(--present);color:#ffffff}
.tile.absent{background:var(--absent);border-color:#555;color:#b0b0b0}
.tile.bounce{animation:tBounce .45s ease forwards}
@keyframes tBounce{0%,100%{transform:translateY(0)}35%{transform:translateY(-14px)}65%{transform:translateY(-6px)}}
.kb{display:flex;flex-direction:column;gap:7px;width:100%;max-width:500px}
.kb-row{display:flex;justify-content:center;gap:6px}
.key{height:var(--key-h,56px);min-width:38px;padding:0 5px;background:var(--s3);border:1px solid var(--border);border-radius:var(--r);color:var(--fg);font-family:var(--fm);font-size:13px;font-weight:500;cursor:pointer;text-transform:uppercase;user-select:none;flex:1;max-width:43px;display:flex;align-items:center;justify-content:center;transition:background .15s,transform .08s}
.key.wide{max-width:66px;font-size:11px}
.key:hover{background:#2a2a2a}.key:active{transform:scale(.93)}
.key.kc{background:var(--correct)!important;border-color:var(--correct)!important;color:#fff!important}
.key.kp{background:var(--present)!important;border-color:var(--present)!important;color:#0a0a0a!important}
.key.ka{background:#161616!important;border-color:#1e1e1e!important;color:var(--absentt)!important}
.modal--r{max-width:480px;text-align:center}
.r-out{font-family:var(--fd);font-size:32px;font-weight:900;margin-bottom:6px}
.r-out.win{color:var(--greenl)}.r-out.lose{color:#d96060}
.r-word{font-family:var(--fm);font-size:12px;color:var(--fg2);letter-spacing:.12em;text-transform:uppercase;margin-bottom:28px}
.r-stats{display:flex;justify-content:center;margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid var(--border)}
.r-stat{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;padding:0 8px;border-right:1px solid var(--border)}
.r-stat:last-child{border-right:none}
.r-sv{font-family:var(--fm);font-size:28px;font-weight:500;line-height:1}
.r-sl{font-family:var(--fm);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)}
.r-dist{margin-bottom:28px;width:100%}
.dt{font-family:var(--fm);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg2);margin-bottom:12px;text-align:center}
.dr{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dl{font-family:var(--fm);font-size:12px;color:var(--fg2);width:14px;text-align:right;flex-shrink:0}
.dbw{flex:1;height:24px}
.db{height:100%;background:var(--s3);border-radius:2px;min-width:28px;display:flex;align-items:center;justify-content:flex-end;padding-right:10px}
.db.cur{background:linear-gradient(90deg,var(--greend),var(--correct))}
.db span{font-family:var(--fm);font-size:11px;color:var(--fg);font-weight:500}
.r-acts{display:flex;gap:10px;justify-content:center;margin-bottom:22px;flex-wrap:wrap}
.r-next{font-family:var(--fm);font-size:12px;color:var(--fg2)}
#nwt{color:var(--gold);font-weight:500}
.hl{color:var(--fg2);padding-left:18px;margin-bottom:22px;font-size:13px;line-height:1.9}
hr.hd{border:none;border-top:1px solid var(--border);margin:18px 0}
.hex{display:flex;flex-direction:column;gap:16px}
.he p{font-size:13px;color:var(--fg2);margin-top:8px}
.he p strong{color:var(--fg)}
.ht{display:flex;gap:5px}
.htile{width:42px;height:42px;border:2px solid var(--bordm);display:flex;align-items:center;justify-content:center;font-family:var(--fm);font-size:17px;font-weight:500;text-transform:uppercase;border-radius:2px}
.htile.c{background:var(--correct);border-color:var(--correct);color:#fff}
.htile.p{background:var(--present);border-color:var(--present);color:#0a0a0a}
.htile.a{background:var(--absent);border-color:#252525;color:var(--absentt)}
@media(max-width:480px){.tile{width:52px;height:52px;font-size:22px}.key{height:50px}}
@media(max-width:360px){.tile{width:44px;height:44px;font-size:18px}.key{height:46px;min-width:30px;font-size:12px}}
@media(hover:none) and (pointer:coarse){#kb{display:none}}
</style>
</head><body class="game-page">
${AD_TOP}${NAV('wordle','<button class="navbar__help" id="helpBtn">?</button>')}
<div class="gh">
  <h1 class="gt">Wordle</h1>
  <p class="gs"><span data-i18n="wordle.subtitle">Guess the 5-letter word in 6 tries</span></p>
  <div class="gm"><span id="gameDate"></span></div>
</div>
<main class="game-main">
  <div><div class="board" id="board"></div></div>
  <div class="toast" id="toast"></div>
  <div class="kb" id="kb">
    <div class="kb-row">
      <button class="key" data-k="q">Q</button><button class="key" data-k="w">W</button><button class="key" data-k="e">E</button><button class="key" data-k="r">R</button><button class="key" data-k="t">T</button><button class="key" data-k="y">Y</button><button class="key" data-k="u">U</button><button class="key" data-k="i">I</button><button class="key" data-k="o">O</button><button class="key" data-k="p">P</button>
    </div>
    <div class="kb-row">
      <button class="key" data-k="a">A</button><button class="key" data-k="s">S</button><button class="key" data-k="d">D</button><button class="key" data-k="f">F</button><button class="key" data-k="g">G</button><button class="key" data-k="h">H</button><button class="key" data-k="j">J</button><button class="key" data-k="k">K</button><button class="key" data-k="l">L</button>
    </div>
    <div class="kb-row">
      <button class="key wide" data-k="Enter">Enter</button><button class="key" data-k="z">Z</button><button class="key" data-k="x">X</button><button class="key" data-k="c">C</button><button class="key" data-k="v">V</button><button class="key" data-k="b">B</button><button class="key" data-k="n">N</button><button class="key" data-k="m">M</button><button class="key wide" data-k="Backspace">⌫</button>
    </div>
  </div>
  <input id="mobileInput" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="position:fixed;top:-200px;left:-200px;opacity:0;width:1px;height:1px;border:none;outline:none;pointer-events:none;">
</main>
${AD_BOT}${FOOTER}
<div class="modal-overlay" id="resultsModal">
  <div class="modal modal--r">
    <div class="r-out" id="rOut"></div>
    <div class="r-word" id="rWord"></div>
    <div class="r-stats">
      <div class="r-stat"><span class="r-sv" id="rP">0</span><span class="r-sl"><span data-i18n="wordle.played">Played</span></span></div>
      <div class="r-stat"><span class="r-sv" id="rW">0%</span><span class="r-sl" data-i18n="wordle.winrate">Win Rate</span></div>
      <div class="r-stat"><span class="r-sv" id="rS">0</span><span class="r-sl">Streak</span></div>
      <div class="r-stat"><span class="r-sv" id="rMS">0</span><span class="r-sl">Max Streak</span></div>
      <div class="r-stat"><span class="r-sv" id="rAG">—</span><span class="r-sl">Avg Guesses</span></div>
    </div>
    <div class="r-dist" id="rDist"></div>
    <div class="r-acts">
      <button class="btn-primary" id="shareBtn">Share 📋</button>
      <a href="/rankings" class="btn-secondary">Rankings</a>
    </div>
    <div class="r-next">Next word in: <span id="nwt">—</span></div>
  </div>
</div>
<div class="modal-overlay" id="helpModal">
  <div class="modal">
    <div class="modal__close" id="helpClose">×</div>
    <h2><span data-i18n="wordle.howtoplay">How to Play</span></h2>
    <p>Guess the hidden 5-letter word in <strong style="color:var(--fg)">6 tries</strong>. New word every day.</p>
    <ul class="hl"><li>Each guess must be a valid 5-letter word.</li><li>Hit <strong style="color:var(--fg)">Enter</strong> to submit.</li><li>Tile colours show how close you are.</li></ul>
    <hr class="hd"/>
    <div class="hex">
      <div class="he"><div class="ht"><div class="htile c">W</div><div class="htile">E</div><div class="htile">A</div><div class="htile">R</div><div class="htile">Y</div></div><p><strong>W</strong> is in the correct spot. 🟩</p></div>
      <div class="he"><div class="ht"><div class="htile">P</div><div class="htile p">I</div><div class="htile">L</div><div class="htile">L</div><div class="htile">S</div></div><p><strong>I</strong> is in the word, wrong spot. 🟨</p></div>
      <div class="he"><div class="ht"><div class="htile">V</div><div class="htile">A</div><div class="htile">G</div><div class="htile a">U</div><div class="htile">E</div></div><p><strong>U</strong> is not in the word. ⬛</p></div>
    </div>
  </div>
</div>
${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<script>
var ANSWERS_EN=${JSON.stringify(WL_5_ANSWERS&&WL_5_ANSWERS.length?WL_5_ANSWERS:FALLBACK_ANSWERS_FILTERED)};
var ANSWERS_FR=${JSON.stringify(WL_FR_5_ANSWERS&&WL_FR_5_ANSWERS.length?WL_FR_5_ANSWERS:FR_ANSWERS_5)};
var EXTRAS_EN=${JSON.stringify(WL_5&&WL_5.length?WL_5:FALLBACK_EXTRAS)};
var EXTRAS_FR=${JSON.stringify(WL_FR_5&&WL_FR_5.length?WL_FR_5:FR_VALID_5)};
var _lang=localStorage.getItem("bn_lang")||"en";
var ANSWERS=_lang==="fr"?ANSWERS_FR:ANSWERS_EN;
var EXTRAS=_lang==="fr"?EXTRAS_FR:EXTRAS_EN;
var VALID={}; var NORM_VALID={};
ANSWERS.forEach(function(w){VALID[w]=1;NORM_VALID[normalize(w)]=w;});
EXTRAS.forEach(function(w){VALID[w]=1;NORM_VALID[normalize(w)]=w;});
function seededShuffle(arr,seed){var a=arr.slice(),s=seed>>>0;for(var i=a.length-1;i>0;i--){s=(Math.imul(s,1664525)+1013904223)>>>0;var j=s%(i+1);var tmp=a[i];a[i]=a[j];a[j]=tmp;}return a;}
function getDailyWord(){var e=new Date('2024-01-01').getTime(),t=new Date();t.setHours(0,0,0,0);var idx=Math.floor((t.getTime()-e)/86400000);var shuffled=seededShuffle(ANSWERS,0xDEADBEEF);return shuffled[idx%shuffled.length].toUpperCase();}
function isValidGuess(w){var lo=w.toLowerCase();return !!(VALID[lo]||NORM_VALID[normalize(lo)]);}
var GAME_ID='wordle',MAX=6,LEN=5;
var state={answer:'',guesses:[],cur:'',over:false,won:false,row:0};
var WIN_MSGS=['Genius!','Magnificent!','Impressive!','Splendid!','Great!','Phew!'];
function buildBoard(){var b=document.getElementById('board');b.innerHTML='';for(var r=0;r<MAX;r++){var row=document.createElement('div');row.className='row';row.id='row'+r;for(var c=0;c<LEN;c++){var t=document.createElement('div');t.className='tile';t.id='t'+r+c;row.appendChild(t);}b.appendChild(row);}}
function tile(r,c){return document.getElementById('t'+r+c);}
function rowEl(r){return document.getElementById('row'+r);}
function updateRow(){for(var c=0;c<LEN;c++){var t=tile(state.row,c),l=state.cur[c]||'';t.textContent=l;t.className='tile'+(l?(' filled'+(c===state.cur.length-1?' active-input':'')):'');}}
function handleKey(key){if(state.over)return;if(key==='Backspace'){if(state.cur.length>0){state.cur=state.cur.slice(0,-1);updateRow();}return;}if(key==='Enter'){submitGuess();return;}if(/^[a-zA-Z]$/.test(key)&&state.cur.length<LEN){state.cur+=key.toUpperCase();updateRow();var t=tile(state.row,state.cur.length-1);t.classList.remove('pop');void t.offsetWidth;t.classList.add('pop');}}
function submitGuess(){if(state.cur.length<LEN){toast((_T&&_T['wordle.notenough'])||'Not enough letters');shake(state.row);return;}if(!isValidGuess(state.cur)){toast((_T&&_T['wordle.notinlist'])||'Not in word list');shake(state.row);return;}var res=evaluate(state.cur,state.answer);revealRow(state.row,state.cur,res,function(){colorKeys(state.cur,res);state.guesses.push(state.cur);var won=normalize(state.cur)===normalize(state.answer),lost=!won&&state.guesses.length>=MAX;if(won||lost){state.over=true;state.won=won;if(won){setTimeout(function(){bounce(state.row);},100);toast(WIN_MSGS[Math.min(state.guesses.length-1,5)],1800);}var stats=GameStats.recordResult(GAME_ID,won,state.guesses.length);saveDay();setTimeout(function(){showResults(won,state.guesses.length,stats);},won?2200:1800);}else{state.row++;state.cur='';saveDay();}});}
function evaluate(guess,answer){var res=[],a=answer.split('').map(function(c){return normalize(c);}),g=guess.split('').map(function(c){return normalize(c);}),i;for(i=0;i<LEN;i++)res.push('absent');for(i=0;i<LEN;i++)if(g[i]===a[i]){res[i]='correct';a[i]=null;g[i]=null;}for(i=0;i<LEN;i++){if(g[i]===null)continue;var j=a.indexOf(g[i]);if(j!==-1){res[i]='present';a[j]=null;}}return res;}
function revealRow(ri,guess,res,cb){var D=300;for(var c=0;c<LEN;c++){(function(col){var t=tile(ri,col);setTimeout(function(){t.classList.add('flip');setTimeout(function(){t.textContent=guess[col];t.className='tile '+res[col];},D/2);},col*D);})(c);}setTimeout(cb,LEN*D);}
function shake(ri){var r=rowEl(ri);r.classList.remove('shake');void r.offsetWidth;r.classList.add('shake');}
function bounce(ri){for(var c=0;c<LEN;c++){(function(col){setTimeout(function(){tile(ri,col).classList.add('bounce');},col*80);})(c);}}
function colorKeys(guess,res){var ORDER={correct:3,present:2,absent:1};for(var c=0;c<LEN;c++){var l=guess[c].toLowerCase();var btn=document.querySelector('.key[data-k="'+l+'"]');if(!btn)continue;var cur=btn.dataset.state||'';if((ORDER[res[c]]||0)>(ORDER[cur]||0)){btn.classList.remove('kc','kp','ka');btn.classList.add(res[c]==='correct'?'kc':res[c]==='present'?'kp':'ka');btn.dataset.state=res[c];}}}
function toast(msg,dur){dur=dur||1200;var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},dur);}
function showResults(won,guesses,stats){if(!stats)stats=GameStats.getStats(GAME_ID);document.getElementById('rOut').textContent=won?'🎉 Brilliant!':'😔 Better luck next time';document.getElementById('rOut').className='r-out '+(won?'win':'lose');document.getElementById('rWord').textContent='The word was: '+state.answer;document.getElementById('rP').textContent=stats.played;document.getElementById('rW').textContent=GameStats.getWinRate(stats)+'%';document.getElementById('rS').textContent=stats.currentStreak;document.getElementById('rMS').textContent=stats.maxStreak;var ag=GameStats.getAvgGuesses(stats);document.getElementById('rAG').textContent=ag||'—';renderDist(stats.distribution,won?guesses:null);countdown();document.getElementById('shareBtn').onclick=function(){shareResult(won,guesses);};document.getElementById('resultsModal').classList.add('open');}
function renderDist(dist,hl){var wrap=document.getElementById('rDist'),max=1,i;for(i=1;i<=6;i++)if((dist[i]||0)>max)max=dist[i];var html='<div class="dt">Guess Distribution</div>';for(i=1;i<=6;i++){var cnt=dist[i]||0,pct=Math.round(cnt/max*100),cur=(hl===i);html+='<div class="dr"><span class="dl">'+i+'</span><div class="dbw"><div class="db'+(cur?' cur':'')+'" style="width:'+Math.max(pct,8)+'%"><span>'+cnt+'</span></div></div></div>';}wrap.innerHTML=html;}
function countdown(){function upd(){var now=new Date(),tom=new Date(now);tom.setDate(tom.getDate()+1);tom.setHours(0,0,0,0);var d=tom-now,h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000),s=Math.floor((d%60000)/1000);var el=document.getElementById('nwt');if(el)el.textContent=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;}upd();setInterval(upd,1000);}
function shareResult(won,guesses){var rows=state.guesses.map(function(g){return evaluate(g,state.answer).map(function(r){return r==='correct'?'🟩':r==='present'?'🟨':'⬛';}).join('');});var txt=['${BRAND} Wordle — '+new Date().toLocaleDateString(),won?guesses+'/6':'X/6'].concat(rows).join(String.fromCharCode(10));navigator.clipboard.writeText(txt).then(function(){toast('Copied!',1500);}).catch(function(){toast('Could not copy',1200);});}
var TODAY_KEY='bn_w_'+_lang+'_'+new Date().toISOString().split('T')[0];
function saveDay(){if(DEV_MODE)return;localStorage.setItem(TODAY_KEY,JSON.stringify({answer:state.answer,guesses:state.guesses,cur:state.cur,over:state.over,won:state.won,row:state.row}));}
function loadDay(){if(DEV_MODE)return null;try{var r=localStorage.getItem(TODAY_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function restoreState(saved){state=Object.assign(state,saved);buildBoard();for(var r=0;r<saved.guesses.length;r++){var g=saved.guesses[r],res=evaluate(g,state.answer);for(var c=0;c<LEN;c++){var t=tile(r,c);t.textContent=g[c];t.className='tile '+res[c];}colorKeys(g,res);}if(!saved.over&&saved.cur){for(var c2=0;c2<saved.cur.length;c2++){var tt=tile(saved.row,c2);tt.textContent=saved.cur[c2];tt.className='tile filled';}}}
var keysAttached=false;
function initGame(){var today=new Date();document.getElementById('gameDate').textContent=today.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});state.answer=getDailyWord();var saved=loadDay();if(saved&&saved.over){restoreState(saved);setTimeout(function(){showResults(saved.won,saved.guesses.length);},600);}else if(saved){restoreState(saved);}else{buildBoard();}if(keysAttached)return;keysAttached=true;document.getElementById('kb').addEventListener('click',function(e){var k=e.target.closest('.key');if(k)handleKey(k.dataset.k);});document.addEventListener('keydown',function(e){if(e.ctrlKey||e.altKey||e.metaKey)return;if(document.querySelector('.modal-overlay.open'))return;var mi=document.getElementById('mobileInput');if(mi&&document.activeElement===mi)return;if(e.key==='Enter')handleKey('Enter');else if(e.key==='Backspace')handleKey('Backspace');else if(/^[a-zA-Z]$/.test(e.key))handleKey(e.key);});
// Mobile native keyboard
var mi=document.getElementById('mobileInput');
if(mi&&(('ontouchstart' in window)||navigator.maxTouchPoints>0)){
  document.querySelector('.game-main').addEventListener('touchstart',function(){if(!state.over)mi.focus();},{passive:true});
  mi.addEventListener('keydown',function(e){if(document.querySelector('.modal-overlay.open'))return;if(e.key==='Enter'){handleKey('Enter');}else if(e.key==='Backspace'){handleKey('Backspace');}});
  mi.addEventListener('input',function(e){var v=this.value;if(v){var last=v[v.length-1];if(/^[a-zA-Z]$/.test(last))handleKey(last);this.value='';}});
}var helpBtn=document.getElementById('helpBtn'),helpModal=document.getElementById('helpModal'),helpClose=document.getElementById('helpClose');if(helpBtn)helpBtn.addEventListener('click',function(){helpModal.classList.add('open');});if(helpClose)helpClose.addEventListener('click',function(){helpModal.classList.remove('open');});if(helpModal)helpModal.addEventListener('click',function(e){if(e.target===helpModal)helpModal.classList.remove('open');});var rm=document.getElementById('resultsModal');if(rm)rm.addEventListener('click',function(e){if(e.target===rm)rm.classList.remove('open');});}
document.addEventListener('DOMContentLoaded',function(){initGame();});
(function(){function fitTiles(){if(window.innerWidth<=640)return;var main=document.querySelector('.game-main');if(!main)return;var h=main.clientHeight;var T=Math.floor((h-126)/8.79);T=Math.max(38,Math.min(60,T));var r=document.documentElement;r.style.setProperty('--tile-sz',T+'px');r.style.setProperty('--tile-fs',Math.round(T*0.433)+'px');r.style.setProperty('--key-h',Math.min(56,Math.round(T*0.933))+'px');}document.addEventListener('DOMContentLoaded',fitTiles);window.addEventListener('resize',fitTiles);if(window.ResizeObserver)document.addEventListener('DOMContentLoaded',function(){var m=document.querySelector('.game-main');if(m)new ResizeObserver(fitTiles).observe(m);});})();
</script>
</body></html>`;
}

// ── PATHLE PAGE ──
function pathlePage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pathle — ${BRAND}</title>${FONTS}${CSS}
<style>
.gh{text-align:center;padding:20px 16px 14px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(91,156,246,.05),transparent)}
.gt{font-family:var(--fd);font-size:34px;font-weight:900;letter-spacing:-.02em;background:linear-gradient(135deg,var(--fg) 30%,#5b9cf6 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.gs{font-family:var(--fm);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg2);margin-top:4px}
.game-main{display:flex;flex-direction:column;align-items:center;padding:20px 16px 36px;gap:18px;flex:1}
.path-info{display:flex;align-items:center;justify-content:center;gap:18px;padding:16px 24px;background:var(--s2);border:1px solid var(--border);border-radius:var(--rl);flex-wrap:wrap;width:100%;max-width:480px}
.path-word{font-family:var(--fm);font-size:22px;font-weight:500;letter-spacing:.08em;text-transform:uppercase}
.path-arrow{color:var(--fg3);font-size:18px}
.path-from{color:#5b9cf6}.path-to{color:#f5a623}
.path-steps{font-family:var(--fm);font-size:11px;color:var(--fg2);letter-spacing:.1em;text-transform:uppercase;text-align:center;margin-top:4px;width:100%}
.path-chain{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-width:340px}
.chain-item{display:flex;align-items:center;gap:8px;width:100%}
.chain-tiles{display:flex;gap:5px}
.ctile{width:44px;height:44px;border:2px solid var(--bordm);display:flex;align-items:center;justify-content:center;font-family:var(--fm);font-size:18px;font-weight:500;text-transform:uppercase;color:var(--fg);background:transparent;border-radius:2px}
.ctile.same{background:var(--s2);color:var(--fg2);border-color:var(--border)}
.ctile.changed{background:#5b9cf6;border-color:#5b9cf6;color:#fff}
.ctile.correct{background:var(--correct);border-color:var(--correct);color:#fff}
.ctile.current{border-color:#5b9cf6}
.chain-step{font-family:var(--fm);font-size:10px;color:var(--fg3);letter-spacing:.08em;text-transform:uppercase;min-width:28px}
.path-input{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;max-width:340px}
.word-input{display:flex;gap:5px}
.winput{width:44px;height:44px;border:2px solid var(--bordm);background:var(--s2);color:var(--fg);font-family:var(--fm);font-size:18px;font-weight:500;text-align:center;text-transform:uppercase;border-radius:2px;outline:none;transition:border-color .12s;touch-action:manipulation}
.winput:focus{border-color:#5b9cf6;box-shadow:0 0 0 3px rgba(91,156,246,.15)}
.winput.changed-input{border-color:#f5a623}
.path-hint{font-family:var(--fm);font-size:10px;color:var(--fg3);letter-spacing:.08em;text-transform:uppercase}
.path-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.btn-blue{background:linear-gradient(135deg,#3a7bd5,#5b9cf6);color:#fff;font-family:var(--fm);font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;padding:11px 24px;border:none;border-radius:var(--r);cursor:pointer;transition:opacity .15s,box-shadow .15s;box-shadow:0 2px 16px rgba(91,156,246,.3)}
.btn-blue:hover{opacity:.9}.btn-blue:active{transform:scale(.97)}
.path-streak{display:flex;align-items:center;gap:8px;font-family:var(--fm);font-size:11px;color:var(--fg2);padding:8px 16px;background:var(--s2);border:1px solid var(--border);border-radius:var(--r)}
.streak-val{color:#5b9cf6;font-size:16px;font-weight:500}
.modal--path{max-width:440px;text-align:center}
.p-out{font-family:var(--fd);font-size:30px;font-weight:900;margin-bottom:8px}
.p-out.win{color:var(--greenl)}.p-out.lose{color:#d96060}
.p-stats{display:flex;justify-content:center;gap:0;margin:20px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:18px 0}
.p-stat{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;border-right:1px solid var(--border)}
.p-stat:last-child{border-right:none}
.p-sv{font-family:var(--fm);font-size:24px;font-weight:500}
.p-sl{font-family:var(--fm);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)}
</style>
</head><body class="game-page">
${AD_TOP}${NAV('pathle')}
<div class="gh">
  <h1 class="gt">Pathle</h1>
  <p class="gs"><span data-i18n="pathle.subtitle">Transform the word — one letter at a time</span></p>
</div>
<main class="game-main">
  <div class="path-info" id="pathInfo">
    <div>
      <span class="path-word path-from" id="pFrom">—</span>
      <span class="path-arrow"> → </span>
      <span class="path-word path-to" id="pTo">—</span>
    </div>
    <div class="path-steps" id="pathSteps"></div>
  </div>
  <div class="path-streak" id="pathStreak">
    🔥 Streak: <span class="streak-val" id="streakVal">0</span>
  </div>
  <div class="path-chain" id="pathChain"></div>
  <div class="path-input" id="pathInputArea">
    <div class="word-input" id="wordInputRow"></div>
    <div class="path-hint" id="pathHint">Change exactly one letter</div>
    <div class="path-actions">
      <button class="btn-blue" id="submitWordBtn">Submit</button>
      <button class="btn-secondary" id="undoWordBtn" style="display:none">↩ Undo</button>
      <button class="btn-secondary" id="giveUpBtn">Give Up</button>
    </div>
  </div>
  <div class="toast" id="toast"></div>
</main>
${AD_BOT}${FOOTER}
<div class="modal-overlay" id="pathResultModal">
  <div class="modal modal--path">
    <div class="p-out" id="pOut"></div>
    <div style="font-family:var(--fm);font-size:12px;color:var(--fg2);margin-bottom:8px" id="pDesc"></div>
    <div class="p-stats">
      <div class="p-stat"><span class="p-sv" id="prPlayed">0</span><span class="p-sl">Played</span></div>
      <div class="p-stat"><span class="p-sv" id="prWin">0%</span><span class="p-sl">Won</span></div>
      <div class="p-stat"><span class="p-sv" id="prStreak">0</span><span class="p-sl">Streak</span></div>
      <div class="p-stat"><span class="p-sv" id="prMax">0</span><span class="p-sl">Best</span></div>
    </div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
      <a href="/pathle" class="btn-blue" style="text-decoration:none">Play Again</a>
      <a href="/rankings" class="btn-secondary" style="text-decoration:none">Rankings</a>
    </div>
  </div>
</div>
${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<script>
// Pathle word lists - 5-letter words for paths
var PW_EN=${JSON.stringify(WL_5_ANSWERS&&WL_5_ANSWERS.length?WL_5_ANSWERS:FALLBACK_PW_FILTERED)};
var PW_FR=${JSON.stringify(WL_FR_5_ANSWERS&&WL_FR_5_ANSWERS.length?WL_FR_5_ANSWERS:FR_ANSWERS_5)};
var PWALL_EN=${JSON.stringify(WL_5&&WL_5.length?WL_5:FALLBACK_PW)};
var PWALL_FR=${JSON.stringify(WL_FR_5&&WL_FR_5.length?WL_FR_5:FR_VALID_5)};
var _langPW=localStorage.getItem("bn_lang")||"en";
var PW=_langPW==="fr"?PW_FR:PW_EN;
var PW_ALL=_langPW==="fr"?PWALL_FR:PWALL_EN;
var PW_SET={};var NORM_PW_SET={};NORM_PW_SET={};
(PW_ALL||PW).forEach(function(w){PW_SET[w]=1;NORM_PW_SET[normalize(w)]=w;});

// Pre-compute adjacency (words 1 letter apart) for BFS
function oneDiff(a,b){var d=0;for(var i=0;i<a.length;i++)if(a[i]!==b[i])d++;return d===1;}

// BFS to find a path between start and end words
function bfsPath(start,end,wordSet){
  var words=Object.keys(wordSet);
  var visited={};visited[start]=null;
  var queue=[start];
  while(queue.length){
    var cur=queue.shift();
    if(cur===end){
      // reconstruct
      var path=[],node=end;
      while(node!==null){path.unshift(node);node=visited[node];}
      return path;
    }
    for(var i=0;i<words.length;i++){
      var w=words[i];
      if(!visited.hasOwnProperty(w)&&oneDiff(cur,w)){
        visited[w]=cur;queue.push(w);
      }
    }
  }
  return null;
}

// Daily puzzle pairs — all have Levenshtein distance ≥ 4 between start and end
var PUZZLES=[
  {from:'black',to:'white',par:6},
  {from:'start',to:'cloud',par:6},
  {from:'stone',to:'bring',par:6},
  {from:'flame',to:'grind',par:6},
  {from:'brave',to:'shout',par:6},
  {from:'shore',to:'blunt',par:6},
  {from:'dance',to:'shirt',par:6},
  {from:'tooth',to:'crane',par:6},
  {from:'globe',to:'tramp',par:6},
  {from:'steam',to:'plunk',par:6},
  {from:'storm',to:'blaze',par:6},
  {from:'thick',to:'novel',par:6},
  {from:'crush',to:'flint',par:6},
  {from:'giant',to:'broke',par:6},
  {from:'light',to:'crumb',par:6},
  {from:'cliff',to:'manor',par:6},
  {from:'crime',to:'blunt',par:6},
  {from:'plank',to:'stove',par:6},
  {from:'birth',to:'swamp',par:6},
  {from:'frost',to:'climb',par:6},
  {from:'drove',to:'sting',par:6},
  {from:'bench',to:'floor',par:6},
  {from:'tiger',to:'cloud',par:6},
  {from:'plant',to:'world',par:6},
  {from:'speak',to:'might',par:6},
  {from:'choir',to:'stunk',par:6},
  {from:'blaze',to:'thorn',par:6},
  {from:'groan',to:'swift',par:6},
  {from:'witch',to:'stale',par:6},
  {from:'notch',to:'gripe',par:6}
];
// 4-letter puzzles — Levenshtein distance = 4 (all letters different)
var PUZZLES4=[
  {from:'cold',to:'warm',par:5},
  {from:'word',to:'game',par:5},
  {from:'head',to:'tail',par:5},
  {from:'best',to:'glow',par:5},
  {from:'dark',to:'love',par:5},
  {from:'fish',to:'club',par:5},
  {from:'rock',to:'vine',par:5},
  {from:'mind',to:'rust',par:5},
  {from:'frog',to:'wish',par:5},
  {from:'king',to:'dust',par:5},
  {from:'fire',to:'band',par:5},
  {from:'myth',to:'core',par:5},
  {from:'crow',to:'slim',par:5},
  {from:'skip',to:'rune',par:5},
  {from:'dump',to:'clef',par:5},
  {from:'grow',to:'link',par:5},
  {from:'debt',to:'clam',par:5},
  {from:'husk',to:'wine',par:5},
  {from:'whip',to:'cord',par:5},
  {from:'fern',to:'stab',par:5}
];

var PUZZLES_FR=[
  {from:'blanc',to:'rouge',par:6},
  {from:'chien',to:'table',par:6},
  {from:'train',to:'plage',par:6},
  {from:'monde',to:'fleur',par:6},
  {from:'carte',to:'livre',par:6},
  {from:'force',to:'titre',par:6},
  {from:'garde',to:'vitre',par:6},
  {from:'juste',to:'vache',par:6},
  {from:'large',to:'pomme',par:6},
  {from:'palme',to:'vente',par:6},
  {from:'plume',to:'vigne',par:6},
  {from:'prose',to:'tombe',par:6},
  {from:'terme',to:'voile',par:6},
  {from:'trace',to:'belle',par:6},
  {from:'chant',to:'livre',par:6},
  {from:'chose',to:'vitre',par:6},
  {from:'ordre',to:'plume',par:6},
  {from:'prise',to:'vache',par:6},
  {from:'titre',to:'mange',par:6},
  {from:'herbe',to:'plage',par:6}
];
function getDailyPuzzle(){
  var e=new Date('2024-01-01').getTime(),t=new Date();t.setHours(0,0,0,0);
  var idx=Math.floor((t.getTime()-e)/86400000);
  if(_langPW==='fr'){return PUZZLES_FR[idx%PUZZLES_FR.length];}
  var pool=PUZZLES.concat(PUZZLES4);
  return pool[idx%pool.length];
}

var PW4_SET={bold:1,gold:1,cold:1,told:1,fold:1,hold:1,mold:1,sold:1,word:1,cord:1,core:1,bore:1,more:1,mare:1,bare:1,care:1,dare:1,fare:1,rare:1,ware:1,wore:1,lore:1,fore:1,gore:1,pore:1,sore:1,tore:1,love:1,live:1,line:1,fine:1,mine:1,wine:1,vine:1,pine:1,dine:1,nine:1,sine:1,hate:1,late:1,fate:1,gate:1,mate:1,rate:1,sate:1,fame:1,game:1,came:1,name:1,same:1,tame:1,lame:1,dame:1,head:1,dead:1,read:1,lead:1,bead:1,mead:1,tail:1,mail:1,rail:1,bail:1,fail:1,hail:1,jail:1,nail:1,pail:1,sail:1,wail:1,band:1,hand:1,land:1,sand:1,wand:1,bend:1,fend:1,lend:1,mend:1,rend:1,send:1,tend:1,vend:1,wend:1,best:1,fest:1,jest:1,nest:1,pest:1,rest:1,test:1,vest:1,west:1,zest:1,back:1,hack:1,jack:1,lack:1,mack:1,pack:1,rack:1,sack:1,tack:1,bird:1,bind:1,find:1,kind:1,mind:1,rind:1,wind:1,blow:1,flow:1,glow:1,know:1,slow:1,show:1,book:1,cook:1,hook:1,look:1,nook:1,took:1,boot:1,hoot:1,loot:1,moot:1,root:1,soot:1,toot:1,born:1,corn:1,horn:1,lorn:1,morn:1,torn:1,worn:1,bump:1,dump:1,hump:1,jump:1,lump:1,pump:1,rump:1,burn:1,fern:1,kern:1,tern:1,turn:1,bust:1,dust:1,gust:1,just:1,lust:1,must:1,rust:1,call:1,ball:1,fall:1,gall:1,hall:1,mall:1,tall:1,wall:1,cave:1,gave:1,have:1,pave:1,rave:1,save:1,wave:1,clay:1,flay:1,play:1,slay:1,stay:1,tray:1,coil:1,foil:1,moil:1,roil:1,soil:1,toil:1,cope:1,dope:1,hope:1,mope:1,rope:1,dark:1,bark:1,cark:1,hark:1,lark:1,mark:1,park:1,dart:1,cart:1,fart:1,hart:1,mart:1,part:1,tart:1,wart:1,dear:1,bear:1,fear:1,gear:1,hear:1,lear:1,near:1,pear:1,rear:1,sear:1,tear:1,wear:1,year:1,deck:1,beck:1,heck:1,neck:1,peck:1,reck:1,teck:1,weck:1};

var gameState={puzzle:null,path:[],over:false,won:false,LEN:0,wordSet:null};

function toast(msg,dur){dur=dur||1400;var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},dur);}

function updateStreak(){
  var s=GameStats.getStats('pathle');
  document.getElementById('streakVal').textContent=s.currentStreak||0;
}

function renderChain(){
  var chain=document.getElementById('pathChain');
  chain.innerHTML='';
  var p=gameState;
  var target=p.puzzle.to.toUpperCase();
  p.path.forEach(function(w,i){
    var prev=i===0?null:p.path[i-1];
    var div=document.createElement('div');div.className='chain-item';
    var step=document.createElement('span');step.className='chain-step';step.textContent='#'+(i+1);
    var tiles=document.createElement('div');tiles.className='chain-tiles';
    for(var c=0;c<w.length;c++){
      var tile=document.createElement('div');
      tile.className='ctile';
      tile.textContent=w[c].toUpperCase();
      if(w===p.puzzle.to){tile.className='ctile correct';}
      else if(prev&&w[c]!==prev[c]){tile.className='ctile changed';}
      else{tile.className='ctile same';}
      tiles.appendChild(tile);
    }
    div.appendChild(step);div.appendChild(tiles);chain.appendChild(div);
  });
}

function buildInputRow(){
  var row=document.getElementById('wordInputRow');
  row.innerHTML='';
  for(var c=0;c<gameState.LEN;c++){
    var inp=document.createElement('input');
    inp.type='text';inp.maxLength=1;inp.className='winput';inp.dataset.col=c;
    inp.addEventListener('input',function(e){
      var v=e.target.value.replace(/[^a-zA-Z]/g,'');
      e.target.value=v.toUpperCase();
      if(v&&parseInt(e.target.dataset.col)<gameState.LEN-1){
        var next=document.querySelectorAll('.winput')[parseInt(e.target.dataset.col)+1];
        if(next)next.focus();
      }
      checkChangedCount();
    });
    inp.addEventListener('keydown',function(e){
      if(e.key==='Backspace'&&!e.target.value){
        var col=parseInt(e.target.dataset.col);
        if(col===0){
          // First letter box is empty → undo to previous word
          var undoBtn=document.getElementById('undoWordBtn');
          if(undoBtn&&undoBtn.style.display!=='none')undoBtn.click();
        } else {
          var prev=document.querySelectorAll('.winput')[col-1];
          if(prev){prev.value='';prev.focus();}
        }
      }
      if(e.key==='Enter')document.getElementById('submitWordBtn').click();
    });
    row.appendChild(inp);
  }
}

function getInputWord(){
  var inputs=document.querySelectorAll('.winput');
  var w='';inputs.forEach(function(i){w+=i.value;});return w.toLowerCase();
}

function checkChangedCount(){
  var inputs=document.querySelectorAll('.winput');
  var prev=gameState.path[gameState.path.length-1];
  var changed=0;
  inputs.forEach(function(inp,i){
    var c=inp.value.toLowerCase();
    if(c&&c!==prev[i])changed++;
    inp.classList.toggle('changed-input',c&&c!==prev[i]);
  });
  var hint=document.getElementById('pathHint');
  if(changed===0)hint.textContent='Change exactly one letter';
  else if(changed===1)hint.textContent='✓ One letter changed';
  else hint.textContent='⚠ Too many changes ('+changed+')';
}

function submitWord(){
  if(gameState.over)return;
  var wRaw=getInputWord();
  var w=normalize(wRaw);
  // Resolve to canonical (accented) form if available
  var ws=gameState.wordSet;var wsNorm=gameState.wordSetNorm||{};
  var wCanon=wsNorm[w]||ws[wRaw]||wRaw;
  if(wCanon.length!==gameState.LEN){toast((_T&&_T['pathle.completeword'])||'Complete the word first');return;}
  var prev=gameState.path[gameState.path.length-1];
  var prevNorm=normalize(prev);
  if(w===prevNorm){toast((_T&&_T['pathle.sameword'])||'Same word as before');return;}
  var diff=0;for(var i=0;i<w.length;i++)if(w[i]!==prevNorm[i])diff++;
  if(diff!==1){toast((_T&&_T['pathle.onechange'])||'Change exactly one letter');return;}
  if(!ws[wRaw]&&!wsNorm[w]){toast((_T&&_T['pathle.notvalid'])||'Not a valid word');return;}
  gameState.path.push(wCanon);
  renderChain();
  document.getElementById('undoWordBtn').style.display='';
  if(w===normalize(gameState.puzzle.to)||wCanon===gameState.puzzle.to){
    // WON
    gameState.over=true;gameState.won=true;
    var steps=gameState.path.length-1;
    var stats=GameStats.recordResult('pathle',true,steps);
    savePathleDay();
    setTimeout(function(){showPathResult(true,steps,stats);},600);
    var area=document.getElementById('pathInputArea');area.style.display='none';
  } else {
    buildInputRow();
    var inputs=document.querySelectorAll('.winput');
    // Pre-fill unchanged letters
    for(var c=0;c<gameState.LEN;c++){
      // keep all same letters prefilled? No — keep blank for next guess
    }
    inputs[0]&&inputs[0].focus();
  }
}

function showPathResult(won,steps,stats){
  document.getElementById('pOut').textContent=won?'🎉 Path found!':'😔 Path not found';
  document.getElementById('pOut').className='p-out '+(won?'win':'lose');
  document.getElementById('pDesc').textContent=won?'Solved in '+steps+' step'+(steps!==1?'s':''):'The path was: '+gameState.puzzle.from+'→…→'+gameState.puzzle.to;
  if(!stats)stats=GameStats.getStats('pathle');
  document.getElementById('prPlayed').textContent=stats.played;
  document.getElementById('prWin').textContent=GameStats.getWinRate(stats)+'%';
  document.getElementById('prStreak').textContent=stats.currentStreak;
  document.getElementById('prMax').textContent=stats.maxStreak;
  document.getElementById('pathResultModal').classList.add('open');
}


function getPathleKey(){var d=new Date();return 'bn_path_'+_langPW+'_'+d.getFullYear()+'-'+(d.getMonth()<9?'0':'')+(d.getMonth()+1)+'-'+(d.getDate()<10?'0':'')+d.getDate();}
function savePathleDay(){try{localStorage.setItem(getPathleKey(),JSON.stringify({over:gameState.over,won:gameState.won,path:gameState.path}));}catch(e){}}
function loadPathleDay(){try{var r=localStorage.getItem(getPathleKey());return r?JSON.parse(r):null;}catch(e){return null;}}
function initPathle(){
  var puzzle=getDailyPuzzle();
  // Ensure puzzle word length matches
  var LEN=puzzle.from.length;
  gameState={puzzle:puzzle,path:[puzzle.from],over:false,won:false,LEN:LEN,wordSet:LEN===5?PW_SET:PW4_SET,wordSetNorm:LEN===5?NORM_PW_SET:{}};
  document.getElementById('pFrom').textContent=puzzle.from.toUpperCase();
  document.getElementById('pTo').textContent=puzzle.to.toUpperCase();
  document.getElementById('pathSteps').textContent='Par: '+puzzle.par+' step'+(puzzle.par!==1?'s':'');
  updateStreak();
  renderChain();
  buildInputRow();
  var inputs=document.querySelectorAll('.winput');
  // Restore saved state if game already played today
  var savedP=loadPathleDay();
  if(savedP&&savedP.over){
    gameState.path=savedP.path;gameState.over=true;gameState.won=savedP.won;
    renderChain();
    document.getElementById('pathInputArea').style.display='none';
    var _steps=gameState.path.length-1;
    setTimeout(function(){showPathResult(gameState.won,gameState.won?_steps:0,GameStats.getStats('pathle'));},400);
  } else if(savedP&&savedP.path&&savedP.path.length>1){
    gameState.path=savedP.path;
    renderChain();
    buildInputRow();
    var _inp=document.querySelectorAll('.winput');_inp[0]&&_inp[0].focus();
  } else {
    inputs[0]&&inputs[0].focus();
  }
  document.getElementById('submitWordBtn').addEventListener('click',submitWord);
  document.getElementById('undoWordBtn').addEventListener('click',function(){
    if(gameState.over)return;
    if(gameState.path.length<=1){toast((_T&&_T['pathle.noundo'])||'Nothing to undo');return;}
    gameState.path.pop();
    renderChain();
    buildInputRow();
    var inputs=document.querySelectorAll('.winput');
    inputs[0]&&inputs[0].focus();
    document.getElementById('undoWordBtn').style.display=gameState.path.length>1?'':'none';
    document.getElementById('pathInputArea').style.display='';
  });
  document.getElementById('giveUpBtn').addEventListener('click',function(){
    if(gameState.over)return;
    gameState.over=true;
    var stats=GameStats.recordResult('pathle',false,0);
    savePathleDay();
    showPathResult(false,0,stats);
    document.getElementById('pathInputArea').style.display='none';
  });
  document.getElementById('pathResultModal').addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
}
document.addEventListener('DOMContentLoaded',initPathle);
</script>
</body></html>`;
}

// ── FASTSPELL PAGE ──
// ── FASTSPELL PAGE ──
function fastspellPage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FastSpell — ${BRAND}</title>${FONTS}${CSS}
<style>
.gh{text-align:center;padding:20px 16px 14px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(245,166,35,.05),transparent)}
.gt{font-family:var(--fd);font-size:34px;font-weight:900;letter-spacing:-.02em;background:linear-gradient(135deg,var(--fg) 30%,#f5a623 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.gs{font-family:var(--fm);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg2);margin-top:4px}
.game-main{display:flex;flex-direction:column;align-items:center;padding:20px 16px 36px;gap:16px;flex:1}
/* Start screen */
.fs-start-screen{display:flex;flex-direction:column;align-items:center;gap:24px;padding:32px 16px;text-align:center;max-width:480px}
.fs-start-title{font-family:var(--fd);font-size:28px;font-weight:700;color:var(--fg)}
.fs-start-rules{font-family:var(--fm);font-size:12px;color:var(--fg2);line-height:1.7;letter-spacing:.03em}
.fs-start-rules b{color:var(--fg);font-weight:600}
.btn-start{background:linear-gradient(135deg,#c87a10,#f5a623);color:#fff;font-family:var(--fd);font-size:18px;font-weight:700;padding:16px 52px;border:none;border-radius:var(--r);cursor:pointer;box-shadow:0 4px 24px rgba(245,166,35,.4);transition:transform .12s,box-shadow .15s;letter-spacing:.04em}
.btn-start:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(245,166,35,.5)}
/* Timer */
.fs-timer-bar{width:100%;max-width:400px;position:relative}
.fs-timer-track{height:6px;background:var(--s3);border-radius:3px;overflow:hidden}
.fs-timer-fill{height:100%;background:linear-gradient(90deg,#f5a623,#e8952a);border-radius:3px;transition:width .25s linear,background .5s}
.fs-timer-fill.urgent{background:linear-gradient(90deg,#e05c5c,#c84040);animation:urgentPulse .5s ease-in-out infinite alternate}
@keyframes urgentPulse{from{opacity:1}to{opacity:.6}}
.fs-timer-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.fs-time-num{font-family:var(--fm);font-size:22px;font-weight:500;color:#f5a623;letter-spacing:.04em;transition:color .3s}
.fs-time-num.urgent{color:#e05c5c}
.fs-score-badge{font-family:var(--fm);font-size:13px;color:var(--fg2);letter-spacing:.06em}
/* Hex ring */
.hex-ring{position:relative;width:260px;height:260px;margin:0 auto;overflow:visible;touch-action:manipulation}
.hex-btn{position:absolute;width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--fm);font-size:22px;font-weight:700;text-transform:uppercase;cursor:pointer;border:2px solid;transition:transform .12s,box-shadow .15s;user-select:none;letter-spacing:0;touch-action:manipulation}
.hex-btn:hover{transform:scale(1.08)}
.hex-btn:active{transform:scale(.94)}
.hex-outer{background:var(--s2);border-color:var(--border);color:var(--fg)}
.hex-outer:hover{border-color:#f5a623;box-shadow:0 0 14px rgba(245,166,35,.2)}
.hex-center{background:linear-gradient(135deg,#c87a10,#f5a623);border-color:#f5a623;color:#fff;box-shadow:0 4px 20px rgba(245,166,35,.35)}
/* Word display */
.fs-word-display{display:flex;align-items:center;gap:6px;min-height:44px;flex-wrap:wrap;justify-content:center;max-width:400px}
.fs-letter{width:36px;height:36px;border:2px solid var(--bordm);border-radius:2px;display:flex;align-items:center;justify-content:center;font-family:var(--fm);font-size:16px;font-weight:700;text-transform:uppercase;color:#ffffff;background:var(--s2)}
.fs-letter.center-letter{border-color:#f5a623;color:#f5a623}
.fs-controls{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.btn-amber{background:linear-gradient(135deg,#c87a10,#f5a623);color:#fff;font-family:var(--fm);font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;padding:10px 22px;border:none;border-radius:var(--r);cursor:pointer;transition:opacity .15s;box-shadow:0 2px 14px rgba(245,166,35,.3);touch-action:manipulation}
.btn-amber:hover{opacity:.9}
.fs-found{width:100%;max-width:500px}
.fs-found-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.fs-found-title{font-family:var(--fm);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg2)}
.fs-found-count{font-family:var(--fm);font-size:12px;color:#f5a623}
.fs-words{display:flex;flex-wrap:wrap;gap:6px}
.fs-word-tag{font-family:var(--fm);font-size:11px;padding:5px 10px;border-radius:4px;background:var(--s2);border:1px solid var(--border);color:var(--fg2);text-transform:uppercase;letter-spacing:.06em}
.fs-word-tag.pangram{background:rgba(245,166,35,.15);border-color:#f5a623;color:#f5a623}
.fs-word-tag.long{background:rgba(91,156,246,.1);border-color:#5b9cf6;color:#5b9cf6}
.toast{position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#ffffff;color:#141414;font-family:var(--fm);font-size:13px;letter-spacing:.06em;padding:10px 22px;border-radius:var(--r);pointer-events:none;opacity:0;transition:opacity .2s;z-index:999;white-space:nowrap}
.toast.show{opacity:1}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:200;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--s1);border:1px solid var(--border);border-radius:var(--rl);padding:32px 28px;max-width:420px;width:calc(100% - 32px);text-align:center}
.modal h2{font-family:var(--fd);font-size:26px;font-weight:900;margin:0 0 8px}
.fs-result-score{font-family:var(--fm);font-size:48px;font-weight:500;color:#f5a623;margin:16px 0 4px}
.fs-result-sub{font-family:var(--fm);font-size:12px;color:var(--fg2);letter-spacing:.1em;text-transform:uppercase;margin-bottom:20px}
.fs-result-words{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-height:180px;overflow-y:auto;margin-bottom:20px}
.btn-secondary{background:transparent;border:1px solid var(--border);color:var(--fg2);font-family:var(--fm);font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;padding:10px 22px;border-radius:var(--r);cursor:pointer;transition:border-color .15s,color .15s;touch-action:manipulation}
.btn-secondary:hover{border-color:var(--fg);color:var(--fg)}
.fs-game-area{display:flex;flex-direction:column;align-items:center;gap:16px;width:100%}
</style>
</head><body class="game-page">
${AD_TOP}${NAV('fastspell')}
<div class="gh">
  <h1 class="gt">FastSpell</h1>
  <p class="gs"><span data-i18n="fs.subtitle">Race the clock — spell as many words as you can</span></p>
</div>
<main class="game-main">
  <div class="toast" id="toast"></div>

  <!-- START SCREEN -->
  <div class="fs-start-screen" id="fsStartScreen">
    <div class="fs-start-title">⚡ 60 Seconds</div>
    <div class="fs-start-rules">
      You'll see <b>7 letters</b> arranged in a ring.<br>
      Build words using only those letters — <b>centre letter required</b>.<br>
      Words must be <b>4+ letters</b>. Letters can be reused.<br>
      <br>
      <b>4 letters</b> = 1pt &nbsp;·&nbsp; <b>5 letters</b> = 5pts &nbsp;·&nbsp; <b>6+ letters</b> = 6+pts<br>
      Use <b>all 7 letters</b> (pangram) for a <b>+10 bonus</b>!
    </div>
    <button class="btn-start" id="fsStartBtn">▶ START</button>
  </div>

  <!-- GAME AREA (hidden until start) -->
  <div class="fs-game-area" id="fsGameArea" style="display:none">
    <!-- Timer -->
    <div class="fs-timer-bar">
      <div class="fs-timer-label">
        <span class="fs-time-num" id="fsTimeNum">60</span>
        <span class="fs-score-badge">Score: <span id="fsScore">0</span> &nbsp;·&nbsp; Found: <span id="fsFound">0</span></span>
      </div>
      <div class="fs-timer-track"><div class="fs-timer-fill" id="fsTimerFill" style="width:100%"></div></div>
    </div>
    <!-- Word being built -->
    <div class="fs-word-display" id="fsWordDisplay"></div>
    <!-- Hex ring -->
    <div class="hex-ring" id="hexRing"></div>
    <!-- Controls -->
    <div class="fs-controls">
      <button class="btn-amber" id="fsEnterBtn">Enter</button>
      <button class="btn-secondary" id="fsDeleteBtn">Delete</button>
      <button class="btn-secondary" id="fsShuffleBtn">Shuffle</button>
    </div>
    <!-- Found words -->
    <div class="fs-found">
      <div class="fs-found-header">
        <span class="fs-found-title">Words Found</span>
        <span class="fs-found-count" id="fsPtsBreak">0 found</span>
      </div>
      <div class="fs-words" id="fsWords"></div>
    </div>
  </div>
</main>
${AD_BOT}${FOOTER}${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<div class="modal-overlay" id="fsResultModal">
  <div class="modal">
    <h2>Time's Up! ⏱</h2>
    <div class="fs-result-score" id="fsFinalScore">0</div>
    <div class="fs-result-sub">points scored</div>
    <div style="display:flex;justify-content:center;gap:0;margin:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:14px 0">
      <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;border-right:1px solid var(--border)"><span style="font-family:var(--fm);font-size:20px;font-weight:500" id="fsStatPlayed">0</span><span style="font-family:var(--fm);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)">Played</span></div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;border-right:1px solid var(--border)"><span style="font-family:var(--fm);font-size:20px;font-weight:500" id="fsStatBest">0</span><span style="font-family:var(--fm);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)">Best Score</span></div>

      <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1"><span style="font-family:var(--fm);font-size:20px;font-weight:500" id="fsStatWords">0</span><span style="font-family:var(--fm);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)">Words Found</span></div>
    </div>
    <div class="fs-result-words" id="fsResultWords"></div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:4px">
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:8px 0 4px"><span style="font-family:var(--fm);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)">Next FastSpell</span><span style="font-family:var(--fm);font-size:16px;color:var(--fg);letter-spacing:.04em" id="fsCountdown">--:--:--</span></div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn-amber" id="fsShareBtn">Share Result</button>
        <a href="/rankings" class="btn-secondary" style="text-decoration:none">Rankings</a>
      </div>
    </div>
  </div>
</div>
<script>
var FS_WORDS_EN=${JSON.stringify(WL_FS||FS_WORDS_BASE_DEFAULT)};
var FS_WORDS_FR=${JSON.stringify(WL_FR_FS&&WL_FR_FS.length?WL_FR_FS:FR_VALID_5)};
var _langFS=localStorage.getItem("bn_lang")||"en";
var FS_WORDS_BASE=_langFS==="fr"?FS_WORDS_FR:FS_WORDS_EN;
var FS_SET={};var NORM_FS_SET={};
FS_WORDS_BASE.forEach(function(w){FS_SET[w]=1;NORM_FS_SET[normalize(w)]=w;});
var LETTER_SETS=[
  ['s','t','r','a','n','e','i'],
  ['c','l','o','u','d','e','r'],
  ['p','a','t','h','e','r','s'],
  ['m','b','l','i','g','n','e'],
  ['f','r','o','u','d','n','t'],
  ['h','a','p','e','r','s','t'],
  ['s','c','o','r','e','n','t'],
  ['c','l','i','m','b','r','e'],
  ['h','u','n','t','r','e','s'],
  ['f','l','i','g','h','t','e'],
  ['d','r','i','v','e','s','n'],
  ['b','l','a','c','k','s','e'],
  ['s','t','o','n','e','r','a'],
  ['w','r','i','t','e','s','n'],
  ['p','l','u','m','b','r','e'],
  ['g','r','e','a','s','t','n'],
  ['c','r','o','w','n','s','e'],
  ['s','h','i','n','e','r','g'],
  ['c','h','a','r','m','s','e'],
  ['f','r','e','s','h','n','e'],
  ['b','r','o','k','e','n','s'],
  ['s','t','e','a','m','r','e']
];
var FR_LETTER_SETS=[
  ['s','o','u','r','i','e','t'],['c','a','l','m','e','r','i'],['p','a','r','d','o','n','e'],
  ['b','o','n','j','u','r','e'],['f','e','u','i','l','a','r'],['m','a','i','s','o','n','e'],
  ['c','h','e','r','a','t','i'],['v','o','i','l','e','a','r'],['p','l','u','m','e','a','i'],
  ['s','a','u','c','e','r','i'],['g','r','a','n','d','e','i'],['t','r','o','u','v','e','a'],
  ['b','r','a','v','e','o','i'],['d','a','n','s','e','u','r'],['f','r','a','n','c','e','i'],
  ['t','a','b','l','e','s','o'],['p','i','e','r','r','e','a'],['c','o','u','l','e','a','r'],
  ['m','o','n','d','e','a','i'],['r','i','v','a','g','e','o'],['n','u','a','g','e','r','i'],
  ['p','e','t','i','t','e','s']
];
var LETTER_SETS_USE=_langFS==="fr"?FR_LETTER_SETS:LETTER_SETS;
function getDailyLetters(){
  var e=new Date('2024-01-01').getTime(),t=new Date();t.setHours(0,0,0,0);
  var idx=Math.floor((t.getTime()-e)/86400000);
  return LETTER_SETS_USE[idx%LETTER_SETS_USE.length];
}
var fsState={letters:[],center:'',current:[],found:{},score:0,pangram:false,timerInterval:null,timeLeft:60,started:false};
function scoreWord(w){if(w.length===4)return 1;if(w.length===5)return 5;return w.length;}
function isPangram(w){var a=fsState.letters.concat([fsState.center]);return a.every(function(l){return w.indexOf(l)!==-1;});}
function isValidFS(w){if(w.length<4)return false;if(w.indexOf(fsState.center)===-1)return false;var allowed=[fsState.center].concat(fsState.letters);for(var i=0;i<w.length;i++){if(allowed.indexOf(w[i])===-1)return false;}return !!(FS_SET[w]||NORM_FS_SET[normalize(w)]);}
function addLetter(l){if(!fsState.started||fsState.timeLeft<=0)return;fsState.current.push(l);renderWordDisplay();}
function deleteLetter(){if(fsState.current.length>0){fsState.current.pop();renderWordDisplay();}}
function renderWordDisplay(){var div=document.getElementById('fsWordDisplay');div.innerHTML='';fsState.current.forEach(function(l){var s=document.createElement('div');s.className='fs-letter'+(l===fsState.center?' center-letter':'');s.textContent=l.toUpperCase();div.appendChild(s);});}
function toast(msg,dur){dur=dur||1000;var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},dur);}
function submitFS(){if(!fsState.started||fsState.timeLeft<=0)return;var w=fsState.current.join('');if(w.length<4){toast((_T&&_T['fs.tooshort'])||'Too short!');return;}var wCanonFS=NORM_FS_SET[normalize(w)]||w;if(fsState.found[wCanonFS]){toast((_T&&_T['fs.already'])||'Already found!');return;}if(!isValidFS(w)){if(w.indexOf(fsState.center)===-1)toast(((_T&&_T['fs.center'])||'must use center letter')+': '+fsState.center.toUpperCase());else toast((_T&&_T['fs.notinlist'])||'Not in word list');return;}var pg=isPangram(wCanonFS);var pts=scoreWord(wCanonFS)+(pg?10:0);fsState.found[wCanonFS]=pts;fsState.score+=pts;if(pg)fsState.pangram=true;document.getElementById('fsScore').textContent=fsState.score;document.getElementById('fsFound').textContent=Object.keys(fsState.found).length;toast(pg?'PANGRAM! +'+pts:'+'+(pts)+' pts',700);renderFoundWords();fsState.current=[];renderWordDisplay();}
function renderFoundWords(){var div=document.getElementById('fsWords');div.innerHTML='';var words=Object.keys(fsState.found).sort();words.forEach(function(w){var span=document.createElement('span');span.className='fs-word-tag'+(isPangram(w)?' pangram':w.length>=6?' long':'');span.textContent=w+(isPangram(w)?' \u2B50':'');div.appendChild(span);});document.getElementById('fsPtsBreak').textContent=Object.keys(fsState.found).length+' found';}
function shuffleLetters(){var arr=fsState.letters.slice();for(var i=arr.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var tmp=arr[i];arr[i]=arr[j];arr[j]=tmp;}fsState.letters=arr;buildHex();}
function buildHex(){var ring=document.getElementById('hexRing');ring.innerHTML='';var positions=[{angle:0},{angle:60},{angle:120},{angle:180},{angle:240},{angle:300}];var R=88,cx=130,cy=130;positions.forEach(function(pos,idx){var rad=pos.angle*Math.PI/180;var x=cx+R*Math.cos(rad)-34,y=cy+R*Math.sin(rad)-34;var btn=document.createElement('button');btn.className='hex-btn hex-outer';btn.textContent=fsState.letters[idx].toUpperCase();btn.style.left=x+'px';btn.style.top=y+'px';(function(letter){btn.onclick=function(){addLetter(letter);};})(fsState.letters[idx]);ring.appendChild(btn);});var cb=document.createElement('button');cb.className='hex-btn hex-center';cb.textContent=fsState.center.toUpperCase();cb.style.left=(cx-34)+'px';cb.style.top=(cy-34)+'px';cb.onclick=function(){addLetter(fsState.center);};ring.appendChild(cb);}
function startTimer(){fsState.timeLeft=60;var fill=document.getElementById('fsTimerFill');var timeNum=document.getElementById('fsTimeNum');function tick(){fsState.timeLeft--;var pct=Math.max(0,fsState.timeLeft/60*100);fill.style.width=pct+'%';timeNum.textContent=fsState.timeLeft;if(fsState.timeLeft<=10){fill.classList.add('urgent');timeNum.classList.add('urgent');}if(fsState.timeLeft<=0){clearInterval(fsState.timerInterval);endGame();}}fsState.timerInterval=setInterval(tick,1000);}
function endGame(){fsState.started=false;saveFSDay(fsState.score,Object.keys(fsState.found),fsState.pangram);var fsStats=GameStats.recordResult('fastspell',fsState.score>0,Object.keys(fsState.found).length);if(!fsStats)fsStats=GameStats.getStats('fastspell');try{var fsRaw=JSON.parse(localStorage.getItem('bn_stats_fastspell')||'{}');fsRaw.totalWords=(fsRaw.totalWords||0)+Object.keys(fsState.found).length;fsRaw.bestScore=Math.max(fsRaw.bestScore||0,fsState.score);fsRaw.pangrams=(fsRaw.pangrams||0)+(fsState.pangram?1:0);localStorage.setItem('bn_stats_fastspell',JSON.stringify(fsRaw));}catch(e){}fsStats=GameStats.getStats('fastspell');document.getElementById('fsFinalScore').textContent=fsState.score;var rw=document.getElementById('fsResultWords');rw.innerHTML='';var words=Object.keys(fsState.found).sort(function(a,b){return fsState.found[b]-fsState.found[a];});words.forEach(function(w){var span=document.createElement('span');span.className='fs-word-tag'+(isPangram(w)?' pangram':w.length>=6?' long':'');span.textContent=w+(isPangram(w)?' \u2B50':'');rw.appendChild(span);});document.getElementById('fsStatPlayed').textContent=fsStats.played||0;var best=0;try{var fsb=localStorage.getItem('bn_fs_best');best=fsb?Math.max(parseInt(fsb)||0,fsState.score):fsState.score;localStorage.setItem('bn_fs_best',best);}catch(e){best=fsState.score;}document.getElementById('fsStatBest').textContent=best;/* streak stat removed - no concept of streak in FastSpell */document.getElementById('fsStatWords').textContent=Object.keys(fsState.found).length;(function(){function upd(){var now=new Date(),tom=new Date(now);tom.setDate(tom.getDate()+1);tom.setHours(0,0,0,0);var d=tom-now,h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000),s=Math.floor((d%60000)/1000);var el=document.getElementById('fsCountdown');if(el)el.textContent=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;}upd();setInterval(upd,1000);})();var fsShareBtn=document.getElementById('fsShareBtn');if(fsShareBtn)fsShareBtn.onclick=function(){var pg=fsState.pangram?' \uD83C\uDF1F':'';var txt='${BRAND} FastSpell'+String.fromCharCode(10)+fsState.score+' pts \u2022 '+Object.keys(fsState.found).length+' words'+pg;navigator.clipboard.writeText(txt).then(function(){fsShareBtn.textContent='Copied!';setTimeout(function(){fsShareBtn.textContent='Share Result';},1500);}).catch(function(){});};document.getElementById('fsResultModal').classList.add('open');}

function getFSKey(){var d=new Date();return 'bn_fs_'+d.getFullYear()+'-'+(d.getMonth()<9?'0':'')+(d.getMonth()+1)+'-'+(d.getDate()<10?'0':'')+d.getDate();}
function saveFSDay(score,words,pangram){try{localStorage.setItem(getFSKey(),JSON.stringify({score:score,words:words,pangram:pangram}));}catch(e){}}
function loadFSDay(){try{var r=localStorage.getItem(getFSKey());return r?JSON.parse(r):null;}catch(e){return null;}}
function startGame(){try {var letters=getDailyLetters();fsState.letters=letters.slice(0,6);fsState.center=letters[6];fsState.current=[];fsState.found={};fsState.score=0;fsState.pangram=false;fsState.started=true;fsState.timeLeft=60;var ss=document.getElementById('fsStartScreen');var ga=document.getElementById('fsGameArea');ss.style.cssText='display:none!important';ga.style.cssText='display:flex!important;flex-direction:column;align-items:center;gap:16px;width:100%';buildHex();renderWordDisplay();renderFoundWords();startTimer();} catch(err) {console.error('startGame error:',err);}}
document.addEventListener('DOMContentLoaded',function(){
  // Check if already played today
  var fsToday=loadFSDay();
  if(fsToday){
    // Set up letters so result display works
    try{
      var letters=getDailyLetters();
      fsState.letters=letters.slice(0,6);fsState.center=letters[6];
      buildHex();
    }catch(e){}
    // Restore found words as objects for display
    fsState.score=fsToday.score;
    fsState.pangram=fsToday.pangram;
    // Show result modal with saved data
    document.getElementById('fsFinalScore').textContent=fsToday.score;
    var rw=document.getElementById('fsResultWords');
    if(rw){rw.innerHTML='';(fsToday.words||[]).forEach(function(w){var span=document.createElement('span');span.className='fs-word-tag';span.textContent=w;rw.appendChild(span);});}
    document.getElementById('fsStatPlayed').textContent=(GameStats.getStats('fastspell').played||0);
    var best=0;try{var fsb=localStorage.getItem('bn_fs_best');best=fsb?parseInt(fsb)||0:0;}catch(e){}
    document.getElementById('fsStatBest').textContent=Math.max(best,fsToday.score);
    document.getElementById('fsStatWords').textContent=(fsToday.words||[]).length;
    (function(){function upd(){var now=new Date(),tom=new Date(now);tom.setDate(tom.getDate()+1);tom.setHours(0,0,0,0);var d=tom-now,h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000),s=Math.floor((d%60000)/1000);var el=document.getElementById('fsCountdown');if(el)el.textContent=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;}upd();setInterval(upd,1000);})();
    document.getElementById('fsResultModal').classList.add('open');
    // Hide start screen, show game area (locked)
    var ss=document.getElementById('fsStartScreen');var ga=document.getElementById('fsGameArea');
    if(ss)ss.style.cssText='display:none!important';
    if(ga)ga.style.cssText='display:flex!important;flex-direction:column;align-items:center;gap:16px;width:100%';
    return;
  }
  document.getElementById('fsStartBtn').onclick=startGame;
  document.getElementById('fsEnterBtn').onclick=submitFS;
  document.getElementById('fsDeleteBtn').onclick=deleteLetter;
  document.getElementById('fsShuffleBtn').onclick=shuffleLetters;
  document.getElementById('fsResultModal').onclick=function(e){if(e.target===this)this.classList.remove('open');};
  document.addEventListener('keydown',function(e){
    if(!fsState.started||fsState.timeLeft<=0)return;
    if(document.querySelector('.modal-overlay.open'))return;
    var allowed=fsState.letters.concat([fsState.center]);
    if(e.key==='Enter'){submitFS();return;}
    if(e.key==='Backspace'){deleteLetter();return;}
    if(/^[a-z]$/i.test(e.key)&&allowed.indexOf(e.key.toLowerCase())!==-1){addLetter(e.key.toLowerCase());}
  });
});
</script>
</body></html>`;
}


// ── BLINDLE PAGE ──
function blindlePage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blindle — ${BRAND}</title>${FONTS}${CSS}
<style>
.gh{text-align:center;padding:24px 16px 16px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(160,107,245,.05),transparent)}
.gt{font-family:var(--fd);font-size:34px;font-weight:900;letter-spacing:-.02em;background:linear-gradient(135deg,var(--fg) 30%,#a06bf5 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.gs{font-family:var(--fm);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg2);margin-top:4px}
.game-main{display:flex;flex-direction:column;align-items:center;padding:24px 16px 36px;gap:16px;flex:1}
.gm{display:flex;align-items:center;justify-content:center;margin-top:6px;font-family:var(--fm);font-size:11px;color:var(--fg3);letter-spacing:.06em}
/* Guess rows */
.bl-board{display:flex;flex-direction:column;gap:10px;width:100%;max-width:420px}
.bl-row{display:flex;align-items:center;gap:10px}
.bl-num{font-family:var(--fm);font-size:11px;color:var(--fg3);width:18px;text-align:right;flex-shrink:0}
.bl-tiles{display:flex;gap:5px;flex:1}
.bl-tile{width:var(--bl-tile-sz,44px);height:var(--bl-tile-sz,44px);border:2px solid var(--bordm);display:flex;align-items:center;justify-content:center;font-family:var(--fm);font-size:var(--bl-tile-fs,18px);font-weight:500;text-transform:uppercase;background:transparent;border-radius:2px;color:#ffffff;font-weight:700;transition:border-color .1s}
.bl-tile.filled{border-color:var(--fg2)}
.bl-tile.active-input{border-color:#a06bf5}
.bl-tile.submitted{background:var(--s2);border-color:var(--border);color:#e8e0d8;font-weight:700}
.bl-tile.pop{animation:pop .1s ease-in-out}
@keyframes pop{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
/* Counters - the key mechanic */
.bl-counters{display:flex;gap:6px;flex-shrink:0}
.bl-counter{width:var(--bl-counter-w,36px);height:var(--bl-tile-sz,44px);border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border:1px solid var(--border)}
.bl-counter-num{font-family:var(--fm);font-size:16px;font-weight:500;line-height:1}
.bl-counter-dot{width:8px;height:8px;border-radius:50%}
.bl-counter.correct{background:#4a9e6e;border-color:#4a9e6e}
.bl-counter.correct .bl-counter-num{color:#000;font-weight:700}
.bl-counter.correct .bl-counter-dot{background:#fff}
.bl-counter.present{background:#c49a28;border-color:#c49a28}
.bl-counter.present .bl-counter-num{color:#000;font-weight:700}
.bl-counter.present .bl-counter-dot{background:#fff}
.bl-counter.absent{background:#e05c5c;border-color:#e05c5c}
.bl-counter.absent .bl-counter-num{color:#000;font-weight:700}
.bl-counter.absent .bl-counter-dot{background:#fff}
/* Pending row (being typed) */
.bl-row.active .bl-tile{border-color:var(--bordm)}
/* Keyboard */
.keyboard{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:4px}
.kb-row{display:flex;gap:5px}
.key{min-width:34px;height:var(--key-h,46px);padding:0 6px;border:none;border-radius:4px;background:var(--s2);color:#ffffff;font-family:var(--fm);font-size:12px;font-weight:600;text-transform:uppercase;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s}
.key:active{transform:scale(.95)}
.key.wide{min-width:54px;font-size:11px}
.kc{background:var(--correct);color:#fff}
.kp{background:var(--amber);color:#fff}
.ka{background:var(--s3);color:var(--fg3)}
/* Toast */
.toast{position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#ffffff;color:#141414;font-family:var(--fm);font-size:13px;letter-spacing:.06em;padding:10px 22px;border-radius:var(--r);pointer-events:none;opacity:0;transition:opacity .2s;z-index:999;white-space:nowrap}
.toast.show{opacity:1}
/* Shake */
@keyframes shakeX{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
.shake{animation:shakeX .4s ease}
/* Results modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:200;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--s1);border:1px solid var(--border);border-radius:var(--rl);padding:32px 28px;max-width:380px;width:calc(100% - 32px);text-align:center}
.r-out{font-family:var(--fd);font-size:28px;font-weight:900;margin-bottom:4px}
.r-out.win{color:var(--greenl)}.r-out.lose{color:#d96060}
.r-word{font-family:var(--fm);font-size:13px;color:var(--fg2);letter-spacing:.08em;text-transform:uppercase;margin-bottom:20px}
.r-stats{display:flex;justify-content:center;gap:0;margin:16px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:16px 0}
.r-stat{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;border-right:1px solid var(--border)}
.r-stat:last-child{border-right:none}
.r-sv{font-family:var(--fm);font-size:22px;font-weight:500}
.r-sl{font-family:var(--fm);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)}
.nwt-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0 4px}
.nwt-label{font-family:var(--fm);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg2)}
.nwt{font-family:var(--fm);font-size:18px;color:var(--fg);letter-spacing:.06em}
.btn-share{background:linear-gradient(135deg,#7a3fcc,#a06bf5);color:#fff;font-family:var(--fm);font-size:12px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;padding:11px 28px;border:none;border-radius:var(--r);cursor:pointer;transition:opacity .15s;box-shadow:0 2px 16px rgba(160,107,245,.3)}
.btn-share:hover{opacity:.9}
/* Help modal */
.help-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:200;align-items:center;justify-content:center}
.help-overlay.open{display:flex}
@media(hover:none) and (pointer:coarse){#kb{display:none}}
.help-box{background:var(--s1);border:1px solid var(--border);border-radius:var(--rl);padding:28px 24px;max-width:380px;width:calc(100% - 32px)}
.help-title{font-family:var(--fd);font-size:20px;font-weight:700;margin-bottom:16px;text-align:center}
.help-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.help-counter-demo{display:flex;gap:5px}
.help-text{font-family:var(--fm);font-size:12px;color:var(--fg2);line-height:1.5}
.help-text b{color:var(--fg)}
</style>
</head><body class="game-page">
${AD_TOP}${NAV('blindle','<button class="navbar__help" id="helpBtn">?</button>')}
<div class="gh">
  <h1 class="gt">Blindle</h1>
  <p class="gs">Guess the word — but you only see the counts</p>
  <p class="gm" id="gameDate"></p>
</div>
<main class="game-main">
  <div class="toast" id="toast"></div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:16px;width:100%;max-width:420px">
  <div class="bl-board" id="board" style="width:100%"></div>
  <div class="keyboard" id="kb">
    <div class="kb-row">
      <button class="key" data-k="q">Q</button><button class="key" data-k="w">W</button><button class="key" data-k="e">E</button><button class="key" data-k="r">R</button><button class="key" data-k="t">T</button><button class="key" data-k="y">Y</button><button class="key" data-k="u">U</button><button class="key" data-k="i">I</button><button class="key" data-k="o">O</button><button class="key" data-k="p">P</button>
    </div>
    <div class="kb-row">
      <button class="key" data-k="a">A</button><button class="key" data-k="s">S</button><button class="key" data-k="d">D</button><button class="key" data-k="f">F</button><button class="key" data-k="g">G</button><button class="key" data-k="h">H</button><button class="key" data-k="j">J</button><button class="key" data-k="k">K</button><button class="key" data-k="l">L</button>
    </div>
    <div class="kb-row">
      <button class="key wide" data-k="Enter">Enter</button><button class="key" data-k="z">Z</button><button class="key" data-k="x">X</button><button class="key" data-k="c">C</button><button class="key" data-k="v">V</button><button class="key" data-k="b">B</button><button class="key" data-k="n">N</button><button class="key" data-k="m">M</button><button class="key wide" data-k="Backspace">&#x232B;</button>
    </div>
  </div>
  <input id="blMobileInput" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="position:fixed;top:-200px;left:-200px;opacity:0;width:1px;height:1px;border:none;outline:none;pointer-events:none;">
  </div>
</main>
${AD_BOT}${FOOTER}${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<!-- Help Modal -->
<div class="help-overlay" id="helpModal">
  <div class="help-box">
    <div class="help-title">How to Play Blindle</div>
    <p class="help-text">Guess the 5-letter word in <b>9 tries</b>.<br><br>After each guess, you see <b>3 counters</b> instead of coloured tiles:</p>
    <div class="help-row">
      <div class="help-counter-demo">
        <div class="bl-counter correct" style="width:36px;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:4px;border:1px solid #4a9e6e;background:rgba(74,158,110,.15)"><span style="font-family:var(--fm);font-size:16px;color:#4a9e6e">2</span><span style="width:8px;height:8px;border-radius:50%;background:#4a9e6e;display:block"></span></div>
      </div>
      <div class="help-text"><b style="color:#4a9e6e">Green</b> = letters in the right position</div>
    </div>
    <div class="help-row">
      <div class="help-counter-demo">
        <div class="bl-counter present" style="width:36px;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:4px;border:1px solid #c49a28;background:rgba(196,154,40,.15)"><span style="font-family:var(--fm);font-size:16px;color:#c49a28">1</span><span style="width:8px;height:8px;border-radius:50%;background:#c49a28;display:block"></span></div>
      </div>
      <div class="help-text"><b style="color:#c49a28">Yellow</b> = letters in the word but wrong position</div>
    </div>
    <div class="help-row">
      <div class="help-counter-demo">
        <div class="bl-counter absent" style="width:36px;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border-radius:4px;border:1px solid #e05c5c;background:rgba(224,92,92,.1)"><span style="font-family:var(--fm);font-size:16px;color:#e05c5c">2</span><span style="width:8px;height:8px;border-radius:50%;background:#e05c5c;display:block"></span></div>
      </div>
      <div class="help-text"><b style="color:#e05c5c">Red</b> = letters not in the word at all</div>
    </div>
    <p class="help-text" style="margin-top:12px">You must figure out <b>which letters</b> are correct, misplaced, or missing — with no position hints!</p>
    <div style="text-align:center;margin-top:20px"><button class="btn-share" id="helpClose" style="background:var(--s2);border:1px solid var(--border);color:var(--fg);box-shadow:none">Got it!</button></div>
  </div>
</div>
<!-- Results Modal -->
<div class="modal-overlay" id="resultsModal">
  <div class="modal">
    <div class="r-out" id="rOut"></div>
    <div class="r-word" id="rWord"></div>
    <div class="r-stats">
      <div class="r-stat"><span class="r-sv" id="rP">0</span><span class="r-sl">Played</span></div>
      <div class="r-stat"><span class="r-sv" id="rW">0</span><span class="r-sl">Win%</span></div>
      <div class="r-stat"><span class="r-sv" id="rS">0</span><span class="r-sl">Streak</span></div>
      <div class="r-stat"><span class="r-sv" id="rMS">0</span><span class="r-sl">Best</span></div>
    </div>
    <div class="nwt-row"><span class="nwt-label">Next Blindle</span><span class="nwt" id="nwt">--:--:--</span></div>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap">
      <button class="btn-share" id="shareBtn">Share Result</button>
      <a href="/rankings" class="btn-share" style="text-decoration:none;background:var(--s2);border:1px solid var(--border);color:var(--fg);box-shadow:none">Rankings</a>
    </div>
  </div>
</div>
<script>
var ANS_BL_EN=${JSON.stringify(WL_5_ANSWERS&&WL_5_ANSWERS.length?WL_5_ANSWERS:FALLBACK_ANSWERS_FILTERED)};
var ANS_BL_FR=${JSON.stringify(WL_FR_5_ANSWERS&&WL_FR_5_ANSWERS.length?WL_FR_5_ANSWERS:FR_ANSWERS_5)};
var EXT_BL_EN=${JSON.stringify(WL_5&&WL_5.length?WL_5:FALLBACK_EXTRAS)};
var EXT_BL_FR=${JSON.stringify(WL_FR_5&&WL_FR_5.length?WL_FR_5:FR_VALID_5)};
var _langBL=localStorage.getItem("bn_lang")||"en";
var ANSWERS_BL=_langBL==="fr"?ANS_BL_FR:ANS_BL_EN;
var EXTRAS_BL=_langBL==="fr"?EXT_BL_FR:EXT_BL_EN;
var VALID_BL={};var NORM_VALID_BL={};
ANSWERS_BL.forEach(function(w){VALID_BL[w]=1;NORM_VALID_BL[normalize(w)]=w;});
EXTRAS_BL.forEach(function(w){VALID_BL[w]=1;NORM_VALID_BL[normalize(w)]=w;});
function getDailyWordBL(){var e=new Date('2025-06-15').getTime(),t=new Date();t.setHours(0,0,0,0);var d=Math.floor((t.getTime()-e)/86400000);return ANSWERS_BL[Math.abs(d*17+307)%ANSWERS_BL.length].toUpperCase();}
function isValidGuessBL(w){var lo=w.toLowerCase();return !!(VALID_BL[lo]||NORM_VALID_BL[normalize(lo)]);}
var BL_GAME_ID='blindle',BL_MAX=9,BL_LEN=5;
var blState={answer:'',guesses:[],cur:'',over:false,won:false,row:0};
function buildBLBoard(){var b=document.getElementById('board');b.innerHTML='';for(var r=0;r<BL_MAX;r++){var row=document.createElement('div');row.className='bl-row';row.id='blrow'+r;var numEl=document.createElement('span');numEl.className='bl-num';numEl.textContent=r+1;var tiles=document.createElement('div');tiles.className='bl-tiles';tiles.id='bltiles'+r;for(var c=0;c<BL_LEN;c++){var t=document.createElement('div');t.className='bl-tile';t.id='blt'+r+c;tiles.appendChild(t);}var counters=document.createElement('div');counters.className='bl-counters';counters.id='blcnt'+r;counters.style.visibility='hidden';['correct','present','absent'].forEach(function(cls){var ctr=document.createElement('div');ctr.className='bl-counter '+cls;var num=document.createElement('span');num.className='bl-counter-num';num.textContent='0';var dot=document.createElement('span');dot.className='bl-counter-dot';ctr.appendChild(num);ctr.appendChild(dot);counters.appendChild(ctr);});row.appendChild(numEl);row.appendChild(tiles);row.appendChild(counters);b.appendChild(row);}}
function bltile(r,c){return document.getElementById('blt'+r+c);}
function blcnt(r){return document.getElementById('blcnt'+r);}
function updateBLRow(){for(var c=0;c<BL_LEN;c++){var t=bltile(blState.row,c),l=blState.cur[c]||'';t.textContent=l;t.className='bl-tile'+(l?(' filled'+(c===blState.cur.length-1?' active-input':'')):'');}}
function handleBLKey(key){if(blState.over)return;if(key==='Backspace'){if(blState.cur.length>0){blState.cur=blState.cur.slice(0,-1);updateBLRow();}return;}if(key==='Enter'){submitBLGuess();return;}if(/^[a-zA-Z]$/.test(key)&&blState.cur.length<BL_LEN){blState.cur+=key.toUpperCase();updateBLRow();var t=bltile(blState.row,blState.cur.length-1);t.classList.remove('pop');void t.offsetWidth;t.classList.add('pop');}}
function submitBLGuess(){if(blState.cur.length<BL_LEN){toastBL((_T&&_T['blindle.notenough'])||'Not enough letters');shakeBL(blState.row);return;}if(!isValidGuessBL(blState.cur)){toastBL((_T&&_T['blindle.notinlist'])||'Not in word list');shakeBL(blState.row);return;}var res=evaluateBL(blState.cur,blState.answer);revealBLRow(blState.row,blState.cur,res,function(){blState.guesses.push(blState.cur);var correct=res.filter(function(r){return r==='correct';}).length;var won=correct===BL_LEN,lost=!won&&blState.guesses.length>=BL_MAX;if(won||lost){blState.over=true;blState.won=won;if(won)toastBL([(_T&&_T['wordle.genius'])||'Genius!',(_T&&_T['wordle.magnificent'])||'Magnificent!',(_T&&_T['wordle.impressive'])||'Impressive!',(_T&&_T['wordle.splendid'])||'Splendid!',(_T&&_T['wordle.great'])||'Great!',(_T&&_T['wordle.phew'])||'Phew!',(_T&&_T['wordle.phew'])||'Phew!',(_T&&_T['wordle.phew'])||'Phew!',(_T&&_T['wordle.phew'])||'Phew!'][Math.min(blState.guesses.length-1,8)],1800);var stats=GameStats.recordResult(BL_GAME_ID,won,blState.guesses.length);saveBLDay();setTimeout(function(){showBLResults(won,blState.guesses.length,stats);},won?2200:1800);}else{blState.row++;blState.cur='';saveBLDay();}});}
function evaluateBL(guess,answer){var res=[],a=answer.split('').map(function(c){return normalize(c);}),g=guess.split('').map(function(c){return normalize(c);}),i;for(i=0;i<BL_LEN;i++)res.push('absent');for(i=0;i<BL_LEN;i++)if(g[i]===a[i]){res[i]='correct';a[i]=null;g[i]=null;}for(i=0;i<BL_LEN;i++){if(g[i]===null)continue;var j=a.indexOf(g[i]);if(j!==-1){res[i]='present';a[j]=null;}}return res;}
function revealBLRow(ri,guess,res,cb){var counters=[0,0,0];res.forEach(function(r){if(r==='correct')counters[0]++;else if(r==='present')counters[1]++;else counters[2]++;});var D=200;for(var c=0;c<BL_LEN;c++){(function(col){var t=bltile(ri,col);setTimeout(function(){t.classList.add('flip');setTimeout(function(){t.textContent=guess[col];t.className='bl-tile submitted';},D/2);},col*D);})(c);}setTimeout(function(){var cntEl=blcnt(ri);cntEl.style.visibility='visible';var ctrs=cntEl.querySelectorAll('.bl-counter-num');ctrs[0].textContent=counters[0];ctrs[1].textContent=counters[1];ctrs[2].textContent=counters[2];cb();},BL_LEN*D);}
function shakeBL(ri){var r=document.getElementById('blrow'+ri);r.classList.remove('shake');void r.offsetWidth;r.classList.add('shake');}
function colorBLKeys(guess,res){/* Blindle: keyboard intentionally stays neutral */}
function toastBL(msg,dur){dur=dur||1200;var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},dur);}
function showBLResults(won,guesses,stats){if(!stats)stats=GameStats.getStats(BL_GAME_ID);document.getElementById('rOut').textContent=won?'\uD83C\uDF89 Brilliant!':'\uD83D\uDE14 Better luck next time';document.getElementById('rOut').className='r-out '+(won?'win':'lose');document.getElementById('rWord').textContent='The word was: '+blState.answer;document.getElementById('rP').textContent=stats.played;document.getElementById('rW').textContent=GameStats.getWinRate(stats)+'%';document.getElementById('rS').textContent=stats.currentStreak;document.getElementById('rMS').textContent=stats.maxStreak;countdownBL();document.getElementById('shareBtn').onclick=function(){shareBLResult(won,guesses);};document.getElementById('resultsModal').classList.add('open');}
function countdownBL(){function upd(){var now=new Date(),tom=new Date(now);tom.setDate(tom.getDate()+1);tom.setHours(0,0,0,0);var d=tom-now,h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000),s=Math.floor((d%60000)/1000);var el=document.getElementById('nwt');if(el)el.textContent=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;}upd();setInterval(upd,1000);}
function shareBLResult(won,guesses){var rows=blState.guesses.map(function(g){var res=evaluateBL(g,blState.answer);var c=res.filter(function(r){return r==='correct';}).length,p=res.filter(function(r){return r==='present';}).length,a=res.filter(function(r){return r==='absent';}).length;return '\uD83D\uDFE9'+c+' \uD83D\uDFE8'+p+' \uD83D\uDFE5'+a;});var txt=['${BRAND} Blindle',won?guesses+'/9':'X/9'].concat(rows).join(String.fromCharCode(10));navigator.clipboard.writeText(txt).then(function(){toastBL('Copied!',1500);}).catch(function(){toastBL('Could not copy',1200);});}
var BL_TODAY_KEY='bn_bl_'+_langBL+'_'+new Date().toISOString().split('T')[0];
function saveBLDay(){if(DEV_MODE)return;localStorage.setItem(BL_TODAY_KEY,JSON.stringify({answer:blState.answer,guesses:blState.guesses,cur:blState.cur,over:blState.over,won:blState.won,row:blState.row}));}
function loadBLDay(){if(DEV_MODE)return null;try{var r=localStorage.getItem(BL_TODAY_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function restoreBLState(saved){blState=Object.assign(blState,saved);buildBLBoard();for(var r=0;r<saved.guesses.length;r++){var g=saved.guesses[r],res=evaluateBL(g,blState.answer);var counters=[0,0,0];res.forEach(function(rv){if(rv==='correct')counters[0]++;else if(rv==='present')counters[1]++;else counters[2]++;});for(var c=0;c<BL_LEN;c++){var t=bltile(r,c);t.textContent=g[c];t.className='bl-tile submitted';}var cntEl=blcnt(r);cntEl.style.visibility='visible';var ctrs=cntEl.querySelectorAll('.bl-counter-num');ctrs[0].textContent=counters[0];ctrs[1].textContent=counters[1];ctrs[2].textContent=counters[2];}if(!saved.over&&saved.cur){for(var c2=0;c2<saved.cur.length;c2++){var tt=bltile(saved.row,c2);tt.textContent=saved.cur[c2];tt.className='bl-tile filled';}}}
var blKeysAttached=false;
function initBlindle(){var today=new Date();document.getElementById('gameDate').textContent=today.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});blState.answer=getDailyWordBL();var saved=loadBLDay();if(saved&&saved.over){restoreBLState(saved);setTimeout(function(){showBLResults(saved.won,saved.guesses.length);},600);}else if(saved){restoreBLState(saved);}else{buildBLBoard();}if(blKeysAttached)return;blKeysAttached=true;document.getElementById('kb').addEventListener('click',function(e){var k=e.target.closest('.key');if(k)handleBLKey(k.dataset.k);});document.addEventListener('keydown',function(e){if(e.ctrlKey||e.altKey||e.metaKey)return;if(document.querySelector('.modal-overlay.open')||document.querySelector('.help-overlay.open'))return;var mi=document.getElementById('blMobileInput');if(mi&&document.activeElement===mi)return;if(e.key==='Enter')handleBLKey('Enter');else if(e.key==='Backspace')handleBLKey('Backspace');else if(/^[a-zA-Z]$/.test(e.key))handleBLKey(e.key);});
// Mobile native keyboard
var mi=document.getElementById('blMobileInput');
if(mi&&(('ontouchstart' in window)||navigator.maxTouchPoints>0)){
  document.querySelector('.game-main').addEventListener('touchstart',function(){if(!blState.over)mi.focus();},{passive:true});
  mi.addEventListener('keydown',function(e){if(document.querySelector('.modal-overlay.open')||document.querySelector('.help-overlay.open'))return;if(e.key==='Enter'){handleBLKey('Enter');}else if(e.key==='Backspace'){handleBLKey('Backspace');}});
  mi.addEventListener('input',function(e){var v=this.value;if(v){var last=v[v.length-1];if(/^[a-zA-Z]$/.test(last))handleBLKey(last);this.value='';}});
}var helpBtn=document.getElementById('helpBtn'),helpModal=document.getElementById('helpModal'),helpClose=document.getElementById('helpClose');if(helpBtn)helpBtn.addEventListener('click',function(){helpModal.classList.add('open');});if(helpClose)helpClose.addEventListener('click',function(){helpModal.classList.remove('open');});if(helpModal)helpModal.addEventListener('click',function(e){if(e.target===helpModal)helpModal.classList.remove('open');});var rm=document.getElementById('resultsModal');if(rm)rm.addEventListener('click',function(e){if(e.target===rm)rm.classList.remove('open');});}
document.addEventListener('DOMContentLoaded',function(){initBlindle();});
(function(){function fitTiles(){var main=document.querySelector('.game-main');if(!main)return;var h=main.clientHeight;var T;if(window.innerWidth<=640){// Mobile: constrain by width (num+tiles+counters must fit) and height (9 rows + gaps)
var Tw=Math.floor((window.innerWidth-102)/7.454);// 102=padding(32)+num(18)+gaps(20)+counters_base(32); 7.454=5tiles+3*0.818counters
var Th=Math.floor((h-156)/9);// 156=board_row_gaps(80)+game-main overhead(76)
T=Math.min(Tw,Th);T=Math.max(24,Math.min(42,T));}else{T=Math.floor((h-168)/12.135);T=Math.max(28,Math.min(44,T));}var r=document.documentElement;r.style.setProperty('--bl-tile-sz',T+'px');r.style.setProperty('--bl-tile-fs',Math.round(T*0.409)+'px');r.style.setProperty('--bl-counter-w',Math.round(T*0.818)+'px');r.style.setProperty('--key-h',Math.min(46,Math.round(T*1.045))+'px');}document.addEventListener('DOMContentLoaded',fitTiles);window.addEventListener('resize',fitTiles);if(window.ResizeObserver)document.addEventListener('DOMContentLoaded',function(){var m=document.querySelector('.game-main');if(m)new ResizeObserver(fitTiles).observe(m);});})();
</script>
</body></html>`;
}



// ── BADGES PAGE ──
function badgesPage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Badges — ${BRAND}</title>
${FONTS}
${CSS}
<style>
.badges-hero{text-align:center;padding:40px 16px 24px;border-bottom:1px solid var(--border)}
.badges-hero h1{font-family:var(--fp);font-size:28px;font-weight:700;margin:0 0 6px}
.badges-hero p{color:var(--fg2);font-size:14px;margin:0}
.badges-summary{display:flex;justify-content:center;gap:32px;padding:20px 16px;border-bottom:1px solid var(--border)}
.badges-summary__item{display:flex;flex-direction:column;align-items:center;gap:4px}
.badges-summary__num{font-family:var(--fm);font-size:28px;font-weight:600;color:var(--fg)}
.badges-summary__label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg3)}
.badges-main{max-width:860px;margin:0 auto;padding:24px 16px 60px}
.badges-section{margin-bottom:36px}
.badges-section__title{font-family:var(--fp);font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg3);padding-bottom:10px;margin-bottom:14px;border-bottom:1px solid var(--border)}
.badges-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.badge-card{background:var(--s2);border:1px solid var(--border);border-radius:12px;padding:18px 16px;display:flex;flex-direction:column;gap:8px;transition:border-color .2s,transform .15s;cursor:default}
.badge-card.earned{border-color:#c9a84c;background:linear-gradient(135deg,var(--s2),rgba(201,168,76,.10))}
.badge-card.locked{opacity:.5}
.badge-card:hover{transform:translateY(-2px)}
.badge-icon-wrap{font-size:34px;line-height:1}
.badge-name{font-family:var(--fp);font-size:14px;font-weight:600;color:var(--fg);line-height:1.2}
.badge-desc{font-size:11px;color:var(--fg3);line-height:1.5}
.badge-earned-tag{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#c9a84c;font-weight:700;margin-top:2px}
.badge-progress{margin-top:4px}
.badge-progress__label{font-size:10px;color:var(--fg3);letter-spacing:.04em;margin-bottom:4px}
.badge-progress__bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.badge-progress__fill{height:100%;background:linear-gradient(90deg,#c9a84c,#e8c96a);border-radius:2px;transition:width .5s ease}
</style>
</head><body>
${NAV('badges')}
<div class="badges-hero">
  <h1>🏅 <span data-i18n="badges.title">Your Badges</span></h1>
  <p><span data-i18n="badges.subtitle">Complete long-term challenges to earn badges across all games.</span></p>
</div>
<div class="badges-summary">
  <div class="badges-summary__item"><span class="badges-summary__num" id="earnedCount">0</span><span class="badges-summary__label">Earned</span></div>
  <div class="badges-summary__item"><span class="badges-summary__num" id="totalCount">0</span><span class="badges-summary__label"><span data-i18n="badges.total">Total</span></div>
  <div class="badges-summary__item"><span class="badges-summary__num" id="pctCount">0%</span><span class="badges-summary__label"><span data-i18n="badges.complete">Complete</span></div>
</div>
<main class="badges-main" id="badgesMain"></main>
${AD_BOT}${FOOTER}${LANG_MODAL}${FRIEND_MODAL}${PLAYER_MODAL}${I18N}${SHARED_JS}
<script>
var BADGE_DEFS = [
  {id:'first_step',   cat:'First Steps', icon:'👣', name:'First Step',       desc:'Play your first game of any kind',                      prog:function(s){return s.any_played;},  max:1},
  {id:'regular',      cat:'First Steps', icon:'📅', name:'Regular',          desc:'Play 7 games total',                                    prog:function(s){return s.any_played;},  max:7},
  {id:'devoted',      cat:'First Steps', icon:'🗓', name:'Devoted',          desc:'Play 30 games total',                                   prog:function(s){return s.any_played;},  max:30},
  {id:'centurion',    cat:'First Steps', icon:'💯', name:'Centurion',        desc:'Play 100 games total',                                  prog:function(s){return s.any_played;},  max:100},
  {id:'wordle_fan',   cat:'First Steps', icon:'🟩', name:'Wordle Fan',       desc:'Play 20 Wordle games',                                  prog:function(s){return s.w_played;},    max:20},
  {id:'pathle_fan',   cat:'First Steps', icon:'🔗', name:'Pathfinder',       desc:'Play 20 Pathle games',                                  prog:function(s){return s.p_played;},    max:20},
  {id:'spell_fan',    cat:'First Steps', icon:'💡', name:'Spellbound',       desc:'Play 20 FastSpell games',                               prog:function(s){return s.f_played;},    max:20},
  {id:'blind_fan',    cat:'First Steps', icon:'🔮', name:'Blindfolded',      desc:'Play 20 Blindle games',                                 prog:function(s){return s.b_played;},    max:20},
  {id:'first_win',    cat:'Victories',   icon:'🥇', name:'First Win',        desc:'Win your first game of any kind',                       prog:function(s){return s.any_wins;},    max:1},
  {id:'hat_trick',    cat:'Victories',   icon:'🔥', name:'Hat Trick',        desc:'Reach a win streak of 3 in any game',                   prog:function(s){return s.any_streak;},  max:3},
  {id:'on_fire',      cat:'Victories',   icon:'🏆', name:'On Fire',          desc:'Reach a win streak of 7 in any game',                   prog:function(s){return s.any_streak;},  max:7},
  {id:'wordle_ace',   cat:'Victories',   icon:'⚡', name:'Wordle Ace',       desc:'Win 10 Wordle games',                                   prog:function(s){return s.w_wins;},      max:10},
  {id:'sharp_mind',   cat:'Victories',   icon:'🎯', name:'Sharp Mind',       desc:'Solve Wordle in 2 guesses or fewer',                    prog:function(s){return s.w_best<=2&&s.w_best>0?1:0;}, max:1},
  {id:'blind_win',    cat:'Victories',   icon:'🦇', name:'Blind Win',        desc:'Win a Blindle game',                                    prog:function(s){return s.b_wins;},      max:1},
  {id:'blind_ace',    cat:'Victories',   icon:'🌑', name:'Blind Ace',        desc:'Win 10 Blindle games',                                  prog:function(s){return s.b_wins;},      max:10},
  {id:'spell_start',  cat:'FastSpell',   icon:'🔡', name:'Getting Started',  desc:'Score 10 points in a single FastSpell round',           prog:function(s){return s.f_best;},      max:10},
  {id:'spell_cast',   cat:'FastSpell',   icon:'✨', name:'Spell Caster',     desc:'Score 50 points in a single FastSpell round',           prog:function(s){return s.f_best;},      max:50},
  {id:'wizard',       cat:'FastSpell',   icon:'🌟', name:'Wizard',           desc:'Score 100 points in a single FastSpell round',          prog:function(s){return s.f_best;},      max:100},
  {id:'pangram',      cat:'FastSpell',   icon:'💎', name:'Pangram Hunter',   desc:'Find a pangram (use all 7 letters) in FastSpell',        prog:function(s){return s.f_pangrams;},  max:1},
  {id:'all_four',     cat:'Dedication',  icon:'🃏', name:'All In',           desc:'Play all 4 games at least once',                        prog:function(s){return (s.w_played>=1?1:0)+(s.p_played>=1?1:0)+(s.f_played>=1?1:0)+(s.b_played>=1?1:0);}, max:4},
  {id:'completionist',cat:'Dedication',  icon:'🎖', name:'Completionist',    desc:'Win at least one game in all 4 modes',                  prog:function(s){return (s.w_wins>=1?1:0)+(s.p_wins>=1?1:0)+(s.f_played>=1?1:0)+(s.b_wins>=1?1:0);}, max:4},
  {id:'veteran',      cat:'Dedication',  icon:'🧙', name:'Veteran',          desc:'Play 50 total games across all modes',                  prog:function(s){return s.any_played;},  max:50},
  {id:'legend',       cat:'Dedication',  icon:'👑', name:'Legend',           desc:'Play 200 total games across all modes',                 prog:function(s){return s.any_played;},  max:200},
];

function getBadgeStats() {
  var w=GameStats.getStats('wordle');
  var p=GameStats.getStats('pathle');
  var f=GameStats.getStats('fastspell');
  var b=GameStats.getStats('blindle');
  var wbest=0;
  [1,2,3,4,5,6].forEach(function(n){if((w.distribution[n]||0)>0&&(!wbest||n<wbest))wbest=n;});
  var fBest=0, fPangrams=0;
  try{var fd=JSON.parse(localStorage.getItem('bn_stats_fastspell')||'{}');fBest=fd.bestScore||0;fPangrams=fd.pangrams||0;}catch(e){}
  return {
    w_played:w.played, w_wins:w.wins, w_best:wbest,
    p_played:p.played, p_wins:p.wins,
    f_played:f.played, f_best:fBest, f_pangrams:fPangrams,
    b_played:b.played, b_wins:b.wins,
    any_played:w.played+p.played+f.played+b.played,
    any_wins:w.wins+p.wins+b.wins,
    any_streak:Math.max(w.maxStreak||0, p.maxStreak||0, b.maxStreak||0),
  };
}

function renderBadges() {
  var stats = getBadgeStats();
  var cats={}, catOrder=[];
  BADGE_DEFS.forEach(function(b){
    if(!cats[b.cat]){cats[b.cat]=[];catOrder.push(b.cat);}
    cats[b.cat].push(b);
  });
  var earnedTotal=0, html='';
  catOrder.forEach(function(cat){
    html+='<section class="badges-section"><div class="badges-section__title">'+((window._T&&window._T['badgecat.'+cat])||cat)+'</div><div class="badges-grid">';
    cats[cat].forEach(function(b){
      var pv=Math.min(b.prog(stats), b.max);
      var earned=pv>=b.max;
      if(earned) earnedTotal++;
      var pct=Math.round((pv/b.max)*100);
      html+='<div class="badge-card '+(earned?'earned':'locked')+'">';
      html+='<div class="badge-icon-wrap">'+(earned?b.icon:'🔒')+'</div>';
      html+='<div class="badge-name">'+((window._T&&window._T['badge.'+b.id])||b.name)+'</div>';
      html+='<div class="badge-desc">'+((window._T&&window._T['badge.'+b.id+'.desc'])||b.desc)+'</div>';
      if(earned){
        html+='<div class="badge-earned-tag">'+((window._T&&window._T['badges.earnedtag'])||'✓ Earned')+'</div>';
      } else {
        html+='<div class="badge-progress"><div class="badge-progress__label">'+pv+' / '+b.max+'</div>';
        html+='<div class="badge-progress__bar"><div class="badge-progress__fill" style="width:'+pct+'%"></div></div></div>';
      }
      html+='</div>';
    });
    html+='</div></section>';
  });
  document.getElementById('badgesMain').innerHTML=html;
  document.getElementById('earnedCount').textContent=earnedTotal;
  document.getElementById('totalCount').textContent=BADGE_DEFS.length;
  document.getElementById('pctCount').textContent=Math.round((earnedTotal/BADGE_DEFS.length)*100)+'%';
}

document.addEventListener('DOMContentLoaded', function(){ renderBadges(); });
</script>
</body></html>`;
}

function resetPage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset Identity</title>
<style>
body{background:#141414;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px}
h1{font-size:20px;margin-bottom:12px;color:#f5d800}
p{color:#888;font-size:13px;margin-bottom:28px}
button{background:#e05c5c;color:#fff;border:none;padding:14px 32px;font-family:monospace;font-size:14px;border-radius:4px;cursor:pointer}
button:hover{background:#c94040}
.done{color:#6ddb96;font-size:14px;margin-top:20px;display:none}
</style>
</head><body>
<div class="box">
  <h1>Reset Identity</h1>
  <p>Clears your stored name and player ID from this browser.<br>Your game stats are kept.</p>
  <button onclick="doReset()">Reset this device</button>
  <div class="done" id="done">Done — <a href="/" style="color:#6ddb96">go home</a></div>
</div>
<script>
function doReset() {
  localStorage.removeItem('bn_player');
  document.cookie = 'bn_uid=; Path=/; Max-Age=0';
  document.querySelector('button').style.display = 'none';
  document.getElementById('done').style.display = 'block';
}
</script>
</body></html>`;
}

// ── SERVER ──
const server = http.createServer(async function(req, res) {
  var url = req.url.split('?')[0];
  var qs  = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';

  // ── API ROUTES ──────────────────────────────────────────────────────────
  if (url.startsWith('/api/')) {
    var uid = getOrCreateUID(req, res);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!db) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'No database configured' }));
      return;
    }

    try {
      // POST /api/state — record / update game stats for this player
      if (url === '/api/state' && req.method === 'POST') {
        var body = await readJSON(req);
        var game = (body.game||'').slice(0, 32);
        if (!game) { res.writeHead(400); res.end(JSON.stringify({error:'missing game'})); return; }
        await db.query(
          'INSERT INTO players(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET last_seen=NOW()',
          [uid]
        );
        await db.query(
          `INSERT INTO game_results(player_id,game,played,wins,current_streak,max_streak,total_guesses_on_win,distribution,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT(player_id,game) DO UPDATE SET
             played=$3, wins=$4, current_streak=$5, max_streak=$6,
             total_guesses_on_win=$7, distribution=$8, updated_at=NOW()`,
          [uid, game,
           body.played||0, body.wins||0, body.currentStreak||0, body.maxStreak||0,
           body.totalGuessesOnWin||0, JSON.stringify(body.distribution||{})]
        );
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /api/state?game=wordle — fetch this player's stats
      if (url === '/api/state' && req.method === 'GET') {
        var gameParam = qs.split('&').find(function(p){return p.startsWith('game=');});
        var game = gameParam ? decodeURIComponent(gameParam.split('=')[1]) : null;
        if (!game) { res.writeHead(400); res.end(JSON.stringify({error:'missing game'})); return; }
        var row = await db.query('SELECT * FROM game_results WHERE player_id=$1 AND game=$2', [uid, game]);
        res.writeHead(200); res.end(JSON.stringify(row.rows[0] || null));
        return;
      }

      // GET /api/rankings?game=wordle — global leaderboard
      if (url === '/api/rankings' && req.method === 'GET') {
        var gameParam = qs.split('&').find(function(p){return p.startsWith('game=');});
        var game = gameParam ? decodeURIComponent(gameParam.split('=')[1]) : 'wordle';
        var result = await db.query(
          `SELECT gr.player_id AS "playerId", p.name, gr.played, gr.wins,
                  gr.total_guesses_on_win AS "totalGuessesOnWin", gr.max_streak AS "maxStreak"
           FROM game_results gr
           JOIN players p ON p.id = gr.player_id
           WHERE gr.game=$1 AND p.name IS NOT NULL AND gr.played > 0
           ORDER BY
             (CASE WHEN gr.played>0 THEN gr.wins::float/gr.played ELSE 0 END) DESC,
             (CASE WHEN gr.wins>0 THEN gr.total_guesses_on_win::float/gr.wins ELSE 99 END) ASC,
             gr.played DESC
           LIMIT 100`,
          [game]
        );
        res.writeHead(200); res.end(JSON.stringify(result.rows));
        return;
      }

      // PATCH /api/me — set display name
      if (url === '/api/me' && req.method === 'PATCH') {
        var body = await readJSON(req);
        var name = ((body.name||'') + '').trim().slice(0, 32);
        if (!name) { res.writeHead(400); res.end(JSON.stringify({error:'invalid name'})); return; }
        await db.query(
          'INSERT INTO players(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=$2, last_seen=NOW()',
          [uid, name]
        );
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
    } catch(e) {
      console.error('[api] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'server error' }));
    }
    return;
  }

  // ── PAGE ROUTES ──────────────────────────────────────────────────────────
  getOrCreateUID(req, res);  // ensure cookie is set on all page loads
  var html;
  if      (url==='/'||url==='/index.html') html=homePage();
  else if (url==='/rankings')              html=rankingsPage();
  else if (url==='/wordle')                html=wordlePage();
  else if (url==='/pathle')                html=pathlePage();
  else if (url==='/fastspell')             html=fastspellPage();
  else if (url==='/blindle')               html=blindlePage();
  else if (url==='/badges')               html=badgesPage();
  else if (url==='/reset')                html=resetPage();
  else if (url==='/setup') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!db) { res.writeHead(200); res.end('<pre>No DATABASE_URL configured.</pre>'); return; }
    var log = [];
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW())`);
      log.push('OK: players table');
      await db.query(`CREATE TABLE IF NOT EXISTS game_results (id SERIAL PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), game TEXT NOT NULL, played INT NOT NULL DEFAULT 0, wins INT NOT NULL DEFAULT 0, current_streak INT NOT NULL DEFAULT 0, max_streak INT NOT NULL DEFAULT 0, total_guesses_on_win INT NOT NULL DEFAULT 0, distribution JSONB, updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(player_id, game))`);
      log.push('OK: game_results table');
      log.push('All done!');
    } catch(e) { log.push('ERROR: ' + e.message); }
    res.writeHead(200); res.end('<pre style="font-family:monospace;padding:40px;background:#111;color:#6ddb96;font-size:14px">' + log.join('\n') + '</pre>');
    return;
  }
  else { res.writeHead(404,{'Content-Type':'text/html'}); res.end('<p style="font-family:sans-serif;padding:40px;color:#888">404 — Page not found</p>'); return; }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(html);
});

server.listen(PORT, function(){
  console.log('\n  🧠 Brainiacs running at http://localhost:'+PORT+'\n');
});