(function (blocks, element, blockEditor, components, serverSideRender, i18n) {
    var el = element.createElement;
    var InspectorControls = blockEditor.InspectorControls;
    var PanelBody = components.PanelBody;
    var RangeControl = components.RangeControl;
    var SelectControl = components.SelectControl;
    var TextControl = components.TextControl;
    var ServerSideRender = serverSideRender;

    blocks.registerBlockType('iconnect-sync/articles', {
        title: i18n.__('iConnect Articles', 'iconnect-sync'),
        description: i18n.__('Display synced iConnect articles.', 'iconnect-sync'),
        icon: 'rss',
        category: 'widgets',
        attributes: {
            limit: {
                type: 'number',
                default: 6
            },
            category: {
                type: 'string',
                default: ''
            },
            layout: {
                type: 'string',
                default: 'grid'
            }
        },

        edit: function (props) {
            var attributes = props.attributes;

            return el(
                element.Fragment,
                null,
                el(
                    InspectorControls,
                    null,
                    el(
                        PanelBody,
                        { title: i18n.__('Article Settings', 'iconnect-sync'), initialOpen: true },
                        el(RangeControl, {
                            label: i18n.__('Number of Articles', 'iconnect-sync'),
                            value: attributes.limit,
                            onChange: function (value) {
                                props.setAttributes({ limit: value });
                            },
                            min: 1,
                            max: 50
                        }),
                        el(TextControl, {
                            label: i18n.__('Filter by Tag', 'iconnect-sync'),
                            value: attributes.category,
                            onChange: function (value) {
                                props.setAttributes({ category: value });
                            },
                            help: i18n.__('Enter a tag name to filter articles.', 'iconnect-sync')
                        }),
                        el(SelectControl, {
                            label: i18n.__('Layout', 'iconnect-sync'),
                            value: attributes.layout,
                            options: [
                                { label: i18n.__('Grid', 'iconnect-sync'), value: 'grid' },
                                { label: i18n.__('List', 'iconnect-sync'), value: 'list' }
                            ],
                            onChange: function (value) {
                                props.setAttributes({ layout: value });
                            }
                        })
                    )
                ),
                el(ServerSideRender, {
                    block: 'iconnect-sync/articles',
                    attributes: attributes
                })
            );
        },

        save: function () {
            return null;
        }
    });
})(
    window.wp.blocks,
    window.wp.element,
    window.wp.blockEditor,
    window.wp.components,
    window.wp.serverSideRender,
    window.wp.i18n
);
