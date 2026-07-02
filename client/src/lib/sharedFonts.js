export const CURATED_FONTS = [
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: "'Degular Medium', 'Poppins', sans-serif", label: 'Degular Medium' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Lato, sans-serif', label: 'Lato' },
  { value: "'Merriweather', serif", label: 'Merriweather' },
  { value: 'Montserrat, sans-serif', label: 'Montserrat' },
  { value: "'Open Sans', sans-serif", label: 'Open Sans' },
  { value: 'Oswald, sans-serif', label: 'Oswald' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
  { value: 'Poppins, sans-serif', label: 'Poppins' },
  { value: 'Raleway, sans-serif', label: 'Raleway' },
  { value: 'Roboto, sans-serif', label: 'Roboto' },
  { value: "'Source Sans Pro', sans-serif", label: 'Source Sans Pro' },
  { value: "'Times New Roman', serif", label: 'Times New Roman' },
  { value: 'Urbanist, sans-serif', label: 'Urbanist' },
  { value: 'Verdana, sans-serif', label: 'Verdana' },
];

export const CURATED_GOOGLE_FONT_NAMES = [
  'Lato',
  'Merriweather',
  'Montserrat',
  'Open+Sans',
  'Oswald',
  'Playfair+Display',
  'Poppins',
  'Raleway',
  'Roboto',
  'Source+Sans+Pro',
  'Urbanist',
];

export const CURATED_GOOGLE_FONTS_URL =
  'https://fonts.googleapis.com/css2?' +
  CURATED_GOOGLE_FONT_NAMES.map(f => `family=${f}:wght@400;500;600;700`).join('&') +
  '&display=swap';
