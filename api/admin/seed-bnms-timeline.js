import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL || 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.DEST_SUPABASE_KEY;

const BNMS_TIMELINE_ITEMS = [
  {
    "year": "1966",
    "heading": "Inaugural meeting of the Nuclear Medicine Society",
    "body": "<p>Inaugural meeting of the Nuclear Medicine Society — <em>Pub in Queensway</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1967",
    "heading": "1967 Highlights",
    "body": "<ul><li>Rules and Byelaws of the Society approved</li><li>Conference on the use of radioactive isotopes in the localisation of tumours — <em>Institute of Cancer Research at Imperial College in London</em></li><li>First Officers Elected: Clive Hayter as President, Ralph McCready as Hon Secretary &amp; Steve Garnett as Treasurer</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1968",
    "heading": "1968 Highlights",
    "body": "<ul><li>First President - Dr C J Hayter from Leeds until 1969</li><li>First Subscriptions established £1</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1969",
    "heading": "Second President - Prof E M McGirr from Glasgow until 1970",
    "body": "<p>Second President - Prof E M McGirr from Glasgow until 1970</p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1970",
    "heading": "Third President - Dr T M D Gimlette from Liverpool until 1971",
    "body": "<p>Third President - Dr T M D Gimlette from Liverpool until 1971</p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1971",
    "heading": "Fourth President - Prof E S Williams from London until 1972",
    "body": "<p>Fourth President - Prof E S Williams from London until 1972</p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1972",
    "heading": "1972 Highlights",
    "body": "<ul><li>The First BNMS Annual Meeting — <em>Windeyer Building, Middlesex Hospital</em></li><li>Fifth President - Prof V R McCready from Sutton until 1974</li><li>Adverse Reactions to Radiopharmaceuticals reporting scheme launched in cooperation with all interested professional bodies</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1973",
    "heading": "BNMS Annual Spring Meeting 1973",
    "body": "<p>BNMS Annual Spring Meeting 1973 — <em>Middlesex Hospital Medical School</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1974",
    "heading": "Sixth President - Prof E Rhys Davies from Bristol until 1976",
    "body": "<p>Sixth President - Prof E Rhys Davies from Bristol until 1976</p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1975",
    "heading": "BNMS Annual Spring Meeting 1975",
    "body": "<p>BNMS Annual Spring Meeting 1975 — <em>University of London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1976",
    "heading": "1976 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1976 — <em>University of London</em></li><li>Seventh President - Dr D Croft from London until 1978</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1977",
    "heading": "BNMS Annual Spring Meeting 1977",
    "body": "<p>BNMS Annual Spring Meeting 1977 — <em>University of London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1978",
    "heading": "Eighth President - Prof M M Maisey from London until 1980",
    "body": "<p>Eighth President - Prof M M Maisey from London until 1980</p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1979",
    "heading": "BNMS Annual Spring Meeting 1979",
    "body": "<p>BNMS Annual Spring Meeting 1979 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1980",
    "heading": "1980 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1980 — <em>Imperial College, London</em></li><li>Ninth President - Dr R F Jewkes from London until 1982</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1981",
    "heading": "BNMS Annual Spring Meeting 1981",
    "body": "<p>BNMS Annual Spring Meeting 1981 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1982",
    "heading": "1982 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1982 — <em>Imperial College, London</em></li><li>Tenth President - Prof K E Britton from London until 1984</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1983",
    "heading": "BNMS Annual Spring Meeting 1983",
    "body": "<p>BNMS Annual Spring Meeting 1983 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1984",
    "heading": "1984 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1984 — <em>Imperial College, London</em></li><li>Eleventh President - Dr L K Harding from Birmingham until 1986</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1985",
    "heading": "The European Nuclear Medicine Society meeting in the Barbican",
    "body": "<p>The European Nuclear Medicine Society meeting in the Barbican — <em>The Barbican</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1986",
    "heading": "1986 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1986 — <em>Imperial College, London</em></li><li>Twelfth President - Prof P S Robinson from Surrey until 1988</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1987",
    "heading": "BNMS Annual Spring Meeting 1987",
    "body": "<p>BNMS Annual Spring Meeting 1987 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1988",
    "heading": "1988 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1988 — <em>Imperial College, London</em></li><li>Thirteenth President - Dr A J Coakley from Canterbury until 1990</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1989",
    "heading": "BNMS Annual Spring Meeting 1989",
    "body": "<p>BNMS Annual Spring Meeting 1989 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1990",
    "heading": "1990 Highlights",
    "body": "<ul><li>Inaugural meeting of the BNMS Technology Group</li><li>BNMS Annual Spring Meeting 1990 — <em>Imperial College, London</em></li><li>Fourteenth President - Prof J H McKillop from Glasgow until 1992</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1991",
    "heading": "BNMS Annual Spring Meeting 1991",
    "body": "<p>BNMS Annual Spring Meeting 1991 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1992",
    "heading": "1992 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1992 — <em>Imperial College, London</em></li><li>Fifteenth President - Dr Susan E M Clarke from London until 1994</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1993",
    "heading": "BNMS Annual Spring Meeting 1993",
    "body": "<p>BNMS Annual Spring Meeting 1993 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1994",
    "heading": "1994 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1994 — <em>Imperial College, London</em></li><li>Sixteenth President - Dr D H Keeling from Portsmouth until 1996</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1995",
    "heading": "BNMS Annual Spring Meeting 1995",
    "body": "<p>BNMS Annual Spring Meeting 1995 — <em>Imperial College, London</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1996",
    "heading": "1996 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1996 — <em>Brighton Conference Centre</em></li><li>Seventeenth President - Dr H W Gray from Glasgow until 1998</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1997",
    "heading": "BNMS Annual Spring Meeting 1997",
    "body": "<p>BNMS Annual Spring Meeting 1997 — <em>Brighton Conference Centre</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "1998",
    "heading": "1998 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 1998 — <em>Brighton Conference Centre</em></li><li>Eighteenth President - Dr T O Nunan from London until 2000</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2000",
    "heading": "2000 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2000 — <em>Brighton Conference Centre</em></li><li>Nineteenth President - Prof P J Robinson from Leeds until 2002</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2001",
    "heading": "BNMS Annual Spring Meeting 2001",
    "body": "<p>BNMS Annual Spring Meeting 2001 — <em>Brighton Conference Centre</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2002",
    "heading": "2002 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2002 — <em>Manchester Central</em></li><li>Twentieth President - Dr M C Prescott from Manchester until 2004</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2003",
    "heading": "BNMS Annual Spring Meeting 2003",
    "body": "<p>BNMS Annual Spring Meeting 2003 — <em>Manchester Central</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2004",
    "heading": "2004 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2004 — <em>Brighton Conference Centre</em></li><li>Twenty-first President - Dr A J Hilson from London until 2006</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2005",
    "heading": "BNMS Annual Spring Meeting 2005",
    "body": "<p>BNMS Annual Spring Meeting 2005 — <em>Manchester Central</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2006",
    "heading": "2006 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2006 — <em>Manchester Central</em></li><li>Twenty-second President - Dr J W Frank from London until 2008</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2007",
    "heading": "BNMS Annual Spring Meeting 2007",
    "body": "<p>BNMS Annual Spring Meeting 2007 — <em>Manchester Central</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2008",
    "heading": "2008 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2008 — <em>Edinburgh International Conference Centre</em></li><li>Twenty-third President - Dr G Vivian from Cornwall until 2010</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2009",
    "heading": "BNMS Annual Spring Meeting 2009",
    "body": "<p>BNMS Annual Spring Meeting 2009 — <em>Manchester Central</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2010",
    "heading": "2010 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2010 — <em>Harrogate International Centre</em></li><li>Twenty-fourth President - Prof A C Perkins MBE from Nottingham until 2012</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2011",
    "heading": "BNMS Annual Spring Meeting 2011",
    "body": "<p>BNMS Annual Spring Meeting 2011 — <em>Brighton Conference Centre</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2012",
    "heading": "2012 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2012 — <em>Harrogate International Centre</em></li><li>Twenty-fifth President - Dr B J Neilly from Glasgow until 2014</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2013",
    "heading": "2013 Highlights",
    "body": "<ul><li>Head Office moved to The Sir Colin Campbell Building, University of Nottingham Innovation Park</li><li>BNMS Annual Spring Meeting 2013 — <em>Brighton Conference Centre</em></li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2014",
    "heading": "2014 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2014 — <em>Harrogate International Centre</em></li><li>Twenty-sixth President - Dr Alp Notghi from Birmingham until 2016</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2015",
    "heading": "BNMS Annual Spring Meeting 2015",
    "body": "<p>BNMS Annual Spring Meeting 2015 — <em>Brighton Conference Centre</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2016",
    "heading": "2016 Highlights",
    "body": "<ul><li>50th Anniversary Meeting -\r\nAnnual Spring Meeting Birmingham 2016 — <em>ICC, Birmingham</em></li><li>Twenty-seventh President - Prof Sobhan Vinjamuri from Liverpool until 2018</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2017",
    "heading": "BNMS Annual Spring Meeting 2017",
    "body": "<p>BNMS Annual Spring Meeting 2017 — <em>ICC, Birmingham</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2018",
    "heading": "2018 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2018 — <em>ICC, Birmingham</em></li><li>Twenty-eighth President - Dr John Buscombe from London until 2021</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2019",
    "heading": "BNMS Annual Spring Meeting 2019",
    "body": "<p>BNMS Annual Spring Meeting 2019</p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2021",
    "heading": "2021 Highlights",
    "body": "<ul><li>BNMS Virtual Annual Meeting 2021 — <em>Virtual</em></li><li>Twenty-ninth President - Prof Richard Graham from Bath until 2023</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2022",
    "heading": "BNMS Annual Spring Meeting 2022",
    "body": "<p>BNMS Annual Spring Meeting 2022 — <em>SEC, Glasgow</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2023",
    "heading": "2023 Highlights",
    "body": "<ul><li>BNMS Annual Spring Meeting 2023 — <em>Harrogate Convention Centre</em></li><li>Thirtieth President - Ms Jilly Croasdale from Birmingham until 2025</li></ul>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2024",
    "heading": "BNMS Annual Spring Meeting 2024",
    "body": "<p>BNMS Annual Spring Meeting 2024 — <em>ICC, Belfast</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  },
  {
    "year": "2025",
    "heading": "BNMS Annual Spring Meeting 2025",
    "body": "<p>BNMS Annual Spring Meeting 2025 — <em>SEC, Glasgow</em></p>",
    "media": {
      "type": "image",
      "src": "",
      "alt": ""
    }
  }
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { page_id, tenant_id } = req.body || {};

  if (!page_id || !tenant_id) {
    return res.status(400).json({ error: 'page_id and tenant_id are required' });
  }

  const timelineContent = {
    title: "BNMS Timeline",
    items: BNMS_TIMELINE_ITEMS,
    line_color: "#d1d5db",
    active_color: "#2563eb",
    marker_size: 14,
    header_offset: 80,
    anchor: "bnms-timeline"
  };

  try {
    const { data: existingElements } = await supabase
      .from('i_edit_page_element')
      .select('display_order')
      .eq('page_id', page_id)
      .order('display_order', { ascending: false })
      .limit(1);

    const nextOrder = existingElements?.length > 0
      ? (existingElements[0].display_order || 0) + 1
      : 0;

    const element = {
      id: randomUUID(),
      page_id,
      tenant_id,
      element_type: 'timeline',
      content: timelineContent,
      style_variant: 'default',
      display_order: nextOrder,
      settings: {
        fullWidth: true,
        paddingTop: 32,
        paddingBottom: 32
      },
    };

    const { data, error } = await supabase
      .from('i_edit_page_element')
      .insert(element)
      .select()
      .single();

    if (error) {
      console.error('Error seeding timeline:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      success: true,
      message: 'BNMS Timeline seeded with ' + BNMS_TIMELINE_ITEMS.length + ' year entries',
      element_id: data.id,
      years_count: BNMS_TIMELINE_ITEMS.length
    });

  } catch (err) {
    console.error('Error seeding BNMS timeline:', err);
    return res.status(500).json({ error: err.message });
  }
}
