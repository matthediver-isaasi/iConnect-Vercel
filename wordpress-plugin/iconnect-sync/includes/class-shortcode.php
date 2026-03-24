<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Shortcode {

    public function __construct() {
        add_shortcode( 'iconnect_articles', array( $this, 'render_shortcode' ) );
        add_action( 'wp_enqueue_scripts', array( $this, 'register_frontend_assets' ) );
    }

    public function register_frontend_assets() {
        wp_register_style( 'iconnect-sync-frontend', ICONNECT_SYNC_PLUGIN_URL . 'assets/css/frontend.css', array(), ICONNECT_SYNC_VERSION );
    }

    public function render_shortcode( $atts ) {
        $atts = shortcode_atts( array(
            'limit'    => 6,
            'category' => '',
            'layout'   => 'grid',
        ), $atts, 'iconnect_articles' );

        $limit  = absint( $atts['limit'] );
        $layout = in_array( $atts['layout'], array( 'grid', 'list' ), true ) ? $atts['layout'] : 'grid';

        wp_enqueue_style( 'iconnect-sync-frontend' );

        $query_args = array(
            'post_type'      => 'iconnect_article',
            'post_status'    => 'publish',
            'posts_per_page' => $limit,
            'orderby'        => 'meta_value',
            'meta_key'       => '_iconnect_published_date',
            'order'          => 'DESC',
        );

        if ( ! empty( $atts['category'] ) ) {
            $query_args['tax_query'] = array(
                array(
                    'taxonomy' => 'iconnect_tag',
                    'field'    => 'name',
                    'terms'    => sanitize_text_field( $atts['category'] ),
                ),
            );
        }

        $query = new WP_Query( $query_args );

        if ( ! $query->have_posts() ) {
            return '<p class="iconnect-no-articles">' . esc_html__( 'No articles found.', 'iconnect-sync' ) . '</p>';
        }

        $output = '<div class="iconnect-articles iconnect-articles--' . esc_attr( $layout ) . '">';

        while ( $query->have_posts() ) {
            $query->the_post();
            $post_id = get_the_ID();

            $author_name    = get_post_meta( $post_id, '_iconnect_author_name', true );
            $published_date = get_post_meta( $post_id, '_iconnect_published_date', true );
            $article_url    = get_post_meta( $post_id, '_iconnect_url', true );
            if ( empty( $article_url ) ) {
                $article_url = get_permalink( $post_id );
            }
            $tags           = wp_get_object_terms( $post_id, 'iconnect_tag', array( 'fields' => 'names' ) );

            $output .= '<article class="iconnect-article-card">';

            if ( has_post_thumbnail( $post_id ) ) {
                $output .= '<div class="iconnect-article-card__image">';
                $output .= '<a href="' . esc_url( $article_url ) . '" target="_blank" rel="noopener noreferrer">';
                $output .= get_the_post_thumbnail( $post_id, 'medium_large', array( 'loading' => 'lazy' ) );
                $output .= '</a>';
                $output .= '</div>';
            }

            $output .= '<div class="iconnect-article-card__content">';

            $output .= '<h3 class="iconnect-article-card__title">';
            $output .= '<a href="' . esc_url( $article_url ) . '" target="_blank" rel="noopener noreferrer">';
            $output .= esc_html( get_the_title() );
            $output .= '</a>';
            $output .= '</h3>';

            if ( ! empty( $author_name ) || ! empty( $published_date ) ) {
                $output .= '<div class="iconnect-article-card__meta">';
                if ( ! empty( $author_name ) ) {
                    $output .= '<span class="iconnect-article-card__author">' . esc_html( $author_name ) . '</span>';
                }
                if ( ! empty( $published_date ) ) {
                    $formatted_date = wp_date( get_option( 'date_format' ), strtotime( $published_date ) );
                    $output .= '<time class="iconnect-article-card__date" datetime="' . esc_attr( $published_date ) . '">' . esc_html( $formatted_date ) . '</time>';
                }
                $output .= '</div>';
            }

            $excerpt = get_the_excerpt();
            if ( ! empty( $excerpt ) ) {
                $output .= '<div class="iconnect-article-card__summary">' . wp_kses_post( wp_trim_words( $excerpt, 30, '&hellip;' ) ) . '</div>';
            }

            if ( ! empty( $tags ) && ! is_wp_error( $tags ) ) {
                $output .= '<div class="iconnect-article-card__tags">';
                foreach ( $tags as $tag ) {
                    $output .= '<span class="iconnect-article-card__tag">' . esc_html( $tag ) . '</span>';
                }
                $output .= '</div>';
            }

            $output .= '<a class="iconnect-article-card__read-more" href="' . esc_url( $article_url ) . '" target="_blank" rel="noopener noreferrer">';
            $output .= esc_html__( 'Read More', 'iconnect-sync' ) . ' &rarr;';
            $output .= '</a>';

            $output .= '</div>';
            $output .= '</article>';
        }

        wp_reset_postdata();

        $output .= '</div>';

        return $output;
    }
}
