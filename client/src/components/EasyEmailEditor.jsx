import { useCallback, useMemo, useRef, useEffect } from 'react';
import { BasicType, JsonToMjml } from 'easy-email-core';
import { EmailEditor, EmailEditorProvider } from 'easy-email-editor';
import { StandardLayout } from 'easy-email-extensions';
import mjml2html from 'mjml-browser';
import 'easy-email-editor/lib/style.css';
import 'easy-email-extensions/lib/style.css';
import '@arco-themes/react-easy-email-theme/css/arco.css';

const defaultPageBlock = {
  type: BasicType.PAGE,
  data: {
    value: {
      breakpoint: '480px',
      headAttributes: '',
      'font-family': 'Arial, sans-serif',
      'font-size': '14px',
      'text-color': '#000000',
      'content-background-color': '#ffffff',
    },
  },
  attributes: {
    'background-color': '#f4f4f4',
    width: '600px',
  },
  children: [
    {
      type: BasicType.SECTION,
      data: {
        value: {
          noWrap: false,
        },
      },
      attributes: {
        padding: '20px 0px 20px 0px',
        'background-repeat': 'repeat',
        'background-size': 'auto',
        'background-position': 'top center',
        border: 'none',
        direction: 'ltr',
        'text-align': 'center',
      },
      children: [
        {
          type: BasicType.COLUMN,
          data: {
            value: {},
          },
          attributes: {
            padding: '0px 0px 0px 0px',
            border: 'none',
            'vertical-align': 'top',
          },
          children: [
            {
              type: BasicType.TEXT,
              data: {
                value: {
                  content: 'Start creating your email content here...',
                },
              },
              attributes: {
                padding: '10px 25px 10px 25px',
                align: 'left',
                'font-size': '14px',
                'line-height': '1.5',
              },
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

function convertDesignToHtml(design) {
  try {
    const mjmlString = JsonToMjml({
      data: design,
      mode: 'production',
      context: null,
    });
    
    const { html, errors } = mjml2html(mjmlString, {
      validationLevel: 'soft',
    });
    
    if (errors && errors.length > 0) {
      console.warn('[EasyEmailEditor] MJML conversion warnings:', errors);
    }
    
    return html;
  } catch (error) {
    console.error('[EasyEmailEditor] Failed to convert design to HTML:', error);
    return null;
  }
}

export default function EasyEmailEditor({ 
  initialDesign, 
  onChange,
  height = 'calc(100vh - 200px)',
  mergeTags = []
}) {
  const debounceRef = useRef(null);
  const lastDesignRef = useRef(null);

  const initialValues = useMemo(() => {
    if (initialDesign && typeof initialDesign === 'object' && initialDesign.type) {
      return {
        subject: '',
        subTitle: '',
        content: initialDesign,
      };
    }
    
    return {
      subject: '',
      subTitle: '',
      content: defaultPageBlock,
    };
  }, [initialDesign]);

  const mergeTagsConfig = useMemo(() => {
    const defaultMergeTags = {
      'Personalization': [
        { value: '{{first_name}}', label: 'First Name' },
        { value: '{{last_name}}', label: 'Last Name' },
        { value: '{{email}}', label: 'Email' },
      ],
      'Links': [
        { value: '{{unsubscribe_link}}', label: 'Unsubscribe Link' },
        { value: '{{preferences_link}}', label: 'Preferences Link' },
      ],
    };

    if (mergeTags && mergeTags.length > 0) {
      return {
        ...defaultMergeTags,
        'Custom': mergeTags.map(tag => ({
          value: `{{${tag}}}`,
          label: tag.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        })),
      };
    }

    return defaultMergeTags;
  }, [mergeTags]);

  const handleChange = useCallback((values) => {
    if (!onChange || !values?.content) return;
    
    const designJson = JSON.stringify(values.content);
    if (designJson === lastDesignRef.current) return;
    lastDesignRef.current = designJson;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      const html = convertDesignToHtml(values.content);
      onChange({
        design: values.content,
        html: html,
      });
    }, 500);
  }, [onChange]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return (
    <div className="easy-email-editor-wrapper" style={{ height }}>
      <EmailEditorProvider
        data={initialValues}
        height={height}
        autoComplete
        dashed={false}
        mergeTags={mergeTagsConfig}
        onBeforePreview={(html, mergeTags) => {
          return html;
        }}
        onUploadImage={async (blob) => {
          return new Promise((resolve, reject) => {
            reject(new Error('Image upload not configured - please use image URLs'));
          });
        }}
      >
        {({ values }, { submit }) => {
          if (values?.content) {
            handleChange(values);
          }
          
          return (
            <StandardLayout 
              showSourceCode={true}
              compact={true}
            >
              <EmailEditor />
            </StandardLayout>
          );
        }}
      </EmailEditorProvider>
    </div>
  );
}

export { convertDesignToHtml, defaultPageBlock };
